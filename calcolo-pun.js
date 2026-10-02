/**
 * CALCOLATORE PUN DA BOLLETTA — secondo SPECIFICA TECNICA
 *
 * Regola fondamentale: il PUN usato è quello riportato nella bolletta,
 * mai quello esterno.
 *
 * Formule:
 *   Prezzo_F = PUN_F × 1,10 + capacity + dispacciamento + spread
 *   capacity       = 0,006288 €/kWh (fisso)
 *   dispacciamento = 0,008 oppure 0,003 €/kWh (selezionabile)
 *   spread         = 0,018 €/kWh (default, modificabile)
 *   perdite        = 10% (il ×1,10)
 *
 * Costi ARERA:
 *   Rete_var   = kWh_tot × 0,04494
 *   Potenza    = kW × 4,386 × mesi
 *   Rete_fissa = 3,72 × mesi
 *   PCV        = 7,87 × mesi
 *   Accisa     = kWh_tot × 0,0125
 *
 *   Imponibile = Materia energia + Rete_var + Potenza + Rete_fissa + PCV + Accisa
 *   IVA        = Imponibile × aliquota
 *   Totale     = Imponibile + IVA
 *
 * Uso Node:
 *   const { estraiPUN, calcolaBolletta } = require('./calcolo-pun');
 *   const pun = estraiPUN(testoBolletta);
 *   const r = calcolaBolletta({ consumi: {F1:100,F2:80,F3:120}, pun, kW:3, mesi:2, iva:0.10 });
 *
 * Uso browser: <script src="calcolo-pun.js"></script> → window.PunBolletta
 * CLI: node calcolo-pun.js --test | --file testo.txt | --json '{"consumi":...}'
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PunBolletta = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ─── Costanti di default da specifica ──────────────────────────────
  const DEFAULTS = {
    capacity: 0.006288,
    dispacciamento: 0.008, // alternativa: 0.003
    spread: 0.018,
    perdite: 0.10, // ×1,10
    reteVar: 0.04494,
    quotaPotenza: 4.386,
    reteFissa: 3.72,
    pcv: 7.87,
    accisa: 0.0125,
    iva: 0.10,
  };

  // ─── Utilità numeri italiani ───────────────────────────────────────
  function parseIT(s) {
    if (s === null || s === undefined) return NaN;
    let str = String(s).trim().replace(/[€\s]/g, '');
    if (!str) return NaN;
    // "1.234,56" → "1234.56" | "0,1234" → "0.1234" | "120.5" → 120.5
    if (str.includes(',')) {
      str = str.replace(/\./g, '').replace(',', '.');
    }
    const n = parseFloat(str);
    return Number.isFinite(n) ? n : NaN;
  }

  /**
   * Il PUN in bolletta è spesso in €/MWh (es. 112,45) oppure in €/kWh (es. 0,11245).
   * Normalizza sempre a €/kWh.
   */
  function normalizzaPun(v) {
    if (!Number.isFinite(v)) return NaN;
    // Soglia: PUN reale sta tra 0,02 e 0,6 €/kWh. Tutto sopra 1,5 è di certo €/MWh.
    if (Math.abs(v) > 1.5) return v / 1000;
    return v;
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  const round5 = (n) => Math.round(n * 100000) / 100000;

  // ─── 2. ESTRAZIONE PUN DI RIFERIMENTO MENSILE ─────────────────────
  //
  // Il PUN che conta è quello MENSILE riportato dal fornitore in bolletta
  // ("PUN", "Prezzo Unico Nazionale", "Indice di riferimento: PUN",
  // "PUN medio mensile", "PUN del mese di ...", fonte GME).
  // Nelle bollette reali i valori stanno spesso in TABELLE MENSILI:
  // l'intestazione dice "PUN" una volta sola e le righe successive
  // ("giugno 2025 104,52 118,30 96,10") non contengono la parola PUN.
  // Per questo, oltre alle righe-PUN, si scansiona il contesto
  // (± righe attorno a ogni ancora PUN) in cerca di righe mensili.

  const RX_PUN = /P\.?\s*U\.?\s*N\.?|PREZZO\s+UNICO\s+NAZIONALE|INDICE\s+DI\s+RIFERIMENTO/i;

  function righeConPun(testo) {
    const lines = String(testo || '').replace(/\r/g, '').split('\n');
    return lines
      .map((l, i) => ({ i, line: l, clean: l.trim() }))
      .filter((o) => RX_PUN.test(o.line));
  }

  /** Estrae i valori numerici €/kWh o €/MWh da una riga. */
  function numeriInRiga(line) {
    const out = [];
    // cattura "0,1234", "112,45", "0.11245" seguiti opzionalmente da unità
    const rx = /(\d{1,4}(?:[.,]\d{3})*[.,]\d{2,6}|\d+[.,]\d{2,6}|\d+[.,]\d{1,6})/g;
    let m;
    while ((m = rx.exec(line)) !== null) {
      const raw = m[1];
      const v = parseIT(raw);
      if (Number.isFinite(v)) out.push({ raw, valore: v, index: m.index });
    }
    return out;
  }

  function fasciaDiRiga(line) {
    const u = line.toUpperCase();
    if (/\bF\s*23\b/.test(u)) return 'F23';
    if (/\bF\s*0\b/.test(u) && /MONO/i.test(u)) return 'MONO';
    if (/\bMONORARI/.test(u)) return 'MONO';
    if (/\bF\s*1\b/.test(u)) return 'F1';
    if (/\bF\s*2\b/.test(u)) return 'F2';
    if (/\bF\s*3\b/.test(u)) return 'F3';
    return null;
  }

  function periodoDiRiga(line) {
    // "01/06–30/06", "01/06/2025 - 30/06/2025", "giugno 2025", "luglio"
    const m = line.match(
      /(\d{1,2}\s*[\/\-.]\s*\d{1,2}(?:\s*[\/\-.]\s*\d{2,4})?)\s*(?:–|—|-)\s*(\d{1,2}\s*[\/\-.]\s*\d{1,2}(?:\s*[\/\-.]\s*\d{2,4})?)/i
    );
    if (m) return (m[1] + '–' + m[2]).replace(/\s+/g, '');
    const mese = line.match(
      /\b(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\b\s*(\d{4})?/i
    );
    if (mese) return mese[0].toLowerCase();
    return null;
  }

  const MESI_IT = { gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6, luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12 };
  const GIORNI_MESE = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  /**
   * Mese di riferimento mensile: "giugno 2025", "mese di luglio",
   * "PUN del mese di giugno 2025", "06/2025", "06-25".
   * Le date complete gg/mm/aaaa sono escluse (le gestisce periodoDiRiga).
   */
  function meseDiRiferimento(line) {
    const m = line.match(
      /\b(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\b\s*(20\d\d)?/i
    );
    if (m) {
      const nome = m[1].toLowerCase();
      const anno = m[2] ? parseInt(m[2], 10) : null;
      return { mese: MESI_IT[nome], anno, label: anno ? `${nome} ${anno}` : nome };
    }
    if (/\d{1,2}\s*[\/\-.]\s*\d{1,2}\s*[\/\-.]\s*\d{2,4}/.test(line)) return null;
    const d = line.match(/(?:^|[^\d])((?:0?[1-9]|1[0-2]))\s*[\/\-.]\s*(20\d\d|\d\d)(?![\d/])/);
    if (d) {
      let anno = parseInt(d[2], 10);
      if (anno < 100) anno += 2000;
      if (anno < 2015 || anno > 2040) return null;
      const nome = Object.keys(MESI_IT).find((k) => MESI_IT[k] === +d[1]);
      return { mese: +d[1], anno, label: `${nome} ${anno}` };
    }
    return null;
  }

  /** Peso in giorni: da intervallo "01/06–30/06" oppure dai giorni del mese. Null se indeterminabile. */
  function pesoPeriodo(periodoStr, meseInfo) {
    const r = String(periodoStr || '').match(
      /(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*(?:–|—|-)\s*(\d{1,2})\s*[\/\-.]\s*(\d{1,2})/
    );
    if (r) {
      const g1 = +r[1], m1 = +r[2], g2 = +r[3], m2 = +r[4];
      if (m1 === m2) return Math.max(1, g2 - g1 + 1);
      if (m2 === m1 + 1 || (m1 === 12 && m2 === 1)) return Math.max(1, GIORNI_MESE[m1 - 1] - g1 + 1 + g2);
      return 30;
    }
    if (meseInfo && meseInfo.mese) return GIORNI_MESE[meseInfo.mese - 1];
    return null;
  }

  // Righe da NON confondere con il PUN (consumi, totali, oneri…)
  const RX_RIGA_NON_PUN =
    /consum|lettura|letture|energia\s+attiva|preliev|totale|importo|iva\b|accisa|pcv|oneri|trasporto|potenza|\bkW\b/i;

  // Offerta a PREZZO FISSO: niente formula PUN, si usa il costo €/kWh
  // riportato in bolletta, applicato alle tre fasce (o monorario).
  const RX_OFFERTA_FISSA =
    /prezzo\s+fisso|prezzo\s+bloccato|prezzo\s+invariabile|prezzi\s+fissi|prezzi\s+bloccati|offerta\s+a\s+prezzo\s+fisso|corrispettivo\s+(fisso|bloccato)|a\s+prezzo\s+fisso|prezzo\s+energia\s+bloccato/i;
  const RX_RIGA_NON_FISSA =
    /lettura|letture|totale|importo|iva\b|fattura|potenza|\bkW\b|consumi?\b|preliev|accisa|pcv|oneri|trasporto|dispacciamento|spread|capacity|perdite/i;
  const RX_FASCIA_RIGA = /\bF\s*23\b|\bF\s*[123]\b|\bF\s*0\b|MONORARI[AO]|FASCIA/i;
  const RX_MONO_RIGA = /vendita\s+mono|\bmono\b(?!\s*fase)|monorari[ao]|prezzo\s+energia|costo\s+energia|corrispettivo\s+energia|componente\s+energia|quota\s+energia/i;

  /**
   * Estrae il PUN dalla bolletta.
   * @returns { tipo:'FASCE'|'MONORARIO'|'F23'|'NON_TROVATO', punF1,punF2,punF3,punMono,
   *            periodi:[{periodo, punF1..}], righe:[...], avvisi:[...] }
   */
  function estraiPUN(testo) {
    const avvisi = [];
    const lines = String(testo || '').replace(/\r/g, '').split('\n');
    const righe = lines
      .map((l, i) => ({ i, line: l }))
      .filter((o) => RX_PUN.test(o.line));
    const per = { F1: [], F2: [], F3: [], MONO: [], F23: [] };
    const fissi = { F1: [], F2: [], F3: [], MONO: [] };
    const offertaFissaDichiarata = RX_OFFERTA_FISSA.test(String(testo || ''));

    /** Numeri-prezzo di riga in €/kWh (scarta anni e valori fuori scala PUN). */
    function numeriPrezzo(line) {
      return numeriInRiga(line)
        .map((n) => ({ ...n, kwh: normalizzaPun(n.valore) }))
        .filter((n) => !(n.valore >= 1900 && n.valore <= 2100))
        .filter((n) => n.kwh > 0.0005 && n.kwh < 2);
    }

    /** Etichetta mensile + peso in giorni di una riga. */
    function infoRiga(line, fonte) {
      const periodo = periodoDiRiga(line);
      const mm = meseDiRiferimento(line);
      return {
        periodo: periodo || (mm && mm.label) || null,
        mese: (mm && mm.mese) || null,
        anno: (mm && mm.anno) || null,
        peso: pesoPeriodo(periodo, mm),
        fonte: fonte || 'riga-PUN',
      };
    }

    /** Deposita i numeri di una riga nelle fasce giuste (dest: per=PUN, fissi=prezzi fissi). */
    function assegnaRiga(line, nums, info, dest) {
      const D = dest || per;
      // Mappa ogni fascia citata nella riga al numero che la segue
      // (gestisce "F1 0,125 F2 0,135 F3 0,110" sulla STESSA riga).
      const fasce = [];
      const rxF = /\bF\s*23\b|\bF\s*0\b|\bMONORARI[AO]\b|\bF\s*1\b|\bF\s*2\b|\bF\s*3\b/gi;
      let fm;
      while ((fm = rxF.exec(line)) !== null) {
        const tok = fm[0].toUpperCase().replace(/\s+/g, '');
        fasce.push({
          key: tok === 'F23' ? 'F23' : tok === 'F0' ? 'MONO' : tok.startsWith('MONO') ? 'MONO' : tok,
          index: fm.index,
        });
      }
      const rec = (valore, raw) => ({
        valore, raw,
        periodo: info.periodo, mese: info.mese, anno: info.anno,
        peso: info.peso, fonte: info.fonte, riga: line.trim(),
      });
      if (fasce.length >= 2 && nums.length >= 2) {
        for (const f of fasce) {
          // numero più vicino DOPO la fascia; se manca, il più vicino in assoluto
          const dopo = nums.filter((n) => n.index > f.index);
          const scelto = dopo.length
            ? dopo[0]
            : nums.slice().sort((a, b) => Math.abs(a.index - f.index) - Math.abs(b.index - f.index))[0];
          D[f.key].push(rec(scelto.kwh, scelto.raw));
        }
        return;
      }
      const fascia = fasciaDiRiga(line);
      // Euristica riga singola: l'ultimo numero è quasi sempre il prezzo
      // (il primo può essere una data). Se fascia nota → assegna.
      const prezzo = nums[nums.length - 1];
      const base = rec(prezzo.kwh, prezzo.raw);
      if (fascia === 'F1') D.F1.push(base);
      else if (fascia === 'F2') D.F2.push(base);
      else if (fascia === 'F3') D.F3.push(base);
      else if (fascia === 'F23') D.F23.push(base);
      else if (fascia === 'MONO') D.MONO.push(base);
      else if (nums.length >= 3) {
        // riga senza fascia esplicita ma 3 numeri → F1/F2/F3
        D.F1.push(rec(nums[nums.length - 3].kwh, nums[nums.length - 3].raw));
        D.F2.push(rec(nums[nums.length - 2].kwh, nums[nums.length - 2].raw));
        D.F3.push(base);
      } else {
        D.MONO.push(base);
      }
    }

    const gestite = new Set();

    // ── FASE 1: righe che contengono la parola PUN ──
    for (const { i, line } of righe) {
      const nums = numeriPrezzo(line);
      if (nums.length === 0) continue;
      assegnaRiga(line, nums, infoRiga(line, 'riga-PUN'));
      gestite.add(i);
    }

    // ── FASE 2: tabelle mensili nel contesto (± righe attorno a ogni ancora PUN) ──
    // Copre i layout reali: header "PUN medio mensile (fonte GME)" seguito da
    // righe "giugno 2025 104,52 118,30 96,10" o "F1: 0,10452 €/kWh" senza mese
    // (eredita il mese dell'ancora).
    for (const { i, line: ancora } of righe) {
      const meseAncora = meseDiRiferimento(ancora);
      const periodoAncora = periodoDiRiga(ancora);
      const unitaContesto = /€\s*\/\s*MWh|€\s*\/\s*kWh|EUR\s*\/\s*MWh|EUR\s*\/\s*kWh|€/.test(ancora);
      for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 8); j++) {
        if (gestite.has(j)) continue;
        const lj = lines[j];
        if (!lj || !lj.trim()) continue;
        if (RX_PUN.test(lj)) continue; // ha PUN: già trattata in Fase 1
        if (/fisso|bloccato|invariabile/i.test(lj)) continue; // prezzo fisso: va in Fase 3, non nel PUN
        const mese = meseDiRiferimento(lj);
        const periodo = periodoDiRiga(lj);
        const haMese = !!(mese || periodo);
        const haFascia = /\bF\s*23\b|\bF\s*[123]\b|\bF\s*0\b|MONORARI[AO]|FASCIA/i.test(lj);
        if (!haMese && !haFascia) continue;
        if (RX_RIGA_NON_PUN.test(lj)) continue; // consumi, totali, oneri, potenza…
        if (/kWh/i.test(lj) && !/€|EUR/i.test(lj)) continue; // "120 kWh" senza € = consumo
        const nums = numeriPrezzo(lj);
        if (nums.length === 0) continue;
        const haUnita = /€|EUR|\/MWh|\/kWh/i.test(lj);
        if (!haFascia && !haUnita && !(unitaContesto && nums.length >= 1)) continue;
        // Senza mese proprio serve una fascia per ereditare il mese dell'ancora
        if (!haMese && (!haFascia || !(meseAncora || periodoAncora))) continue;
        const info = haMese
          ? {
              periodo: periodo || (mese && mese.label),
              mese: mese && mese.mese, anno: mese && mese.anno,
              peso: pesoPeriodo(periodo, mese), fonte: 'tabella-mensile',
            }
          : {
              periodo: periodoAncora || (meseAncora && meseAncora.label),
              mese: meseAncora && meseAncora.mese, anno: meseAncora && meseAncora.anno,
              peso: pesoPeriodo(periodoAncora, meseAncora),
              fonte: 'tabella-mensile (mese ancora)',
            };
        if (!info.periodo) continue;
        assegnaRiga(lj, nums, info);
        gestite.add(j);
      }
    }

    // ── FASE 3: offerta a prezzo fisso → costo €/kWh per fascia ──
    // Righe con fascia (o dicitura monoraria) + prezzo in €, senza parola PUN.
    // Il costo fisso si applica così com'è alle tre fasce (niente formula PUN).
    for (let k = 0; k < lines.length; k++) {
      if (gestite.has(k)) continue;
      const lj = lines[k];
      if (!lj || !lj.trim()) continue;
      if (RX_PUN.test(lj)) continue;
      if (!/€|EUR/i.test(lj)) continue; // il prezzo fisso è sempre in €
      if (RX_RIGA_NON_FISSA.test(lj)) continue; // totali, IVA, oneri, potenza…
      const haFascia = RX_FASCIA_RIGA.test(lj);
      if (!haFascia && !RX_MONO_RIGA.test(lj)) continue;
      const nums = numeriPrezzo(lj);
      if (nums.length === 0) continue;
      if (!haFascia) {
        // Monorario senza sigla fascia: il primo numero è il prezzo
        // ("Prezzo energia 0,14500 €/kWh, valido fino al…")
        fissi.MONO.push({ valore: nums[0].kwh, raw: nums[0].raw, periodo: null, mese: null, anno: null, peso: null, fonte: 'prezzo-fisso', riga: lj.trim() });
      } else {
        assegnaRiga(lj, nums, { periodo: null, mese: null, anno: null, peso: null, fonte: 'prezzo-fisso' }, fissi);
      }
      gestite.add(k);
    }

    // Fallback tabella compatta senza mesi: "F1 0,1234 F2 0,1345 F3 0,1111"
    // su righe vicine al PUN (vale solo se la Fase 2 non ha trovato mesi).
    if (per.F1.length === 0 && per.F2.length === 0 && per.F3.length === 0 && per.MONO.length === 0 && per.F23.length === 0) {
      const idxPun = lines.findIndex((l) => RX_PUN.test(l));
      if (idxPun >= 0) {
        const finestra = lines.slice(Math.max(0, idxPun - 2), idxPun + 6).join('\n');
        for (const f of ['F1', 'F2', 'F3']) {
          // \b evita che "F23" venga letto come "F2"; richiesto il decimale
          const m = finestra.match(new RegExp(f + '\\b[^\\d]{0,10}(\\d+[.,]\\d+)', 'i'));
          if (m) {
            const v = normalizzaPun(parseIT(m[1]));
            if (Number.isFinite(v) && v > 0.0005 && v < 2) {
              per[f].push({ valore: v, raw: m[1], periodo: null, mese: null, anno: null, peso: null, fonte: 'tabella-compatta', riga: m[0] });
            }
          }
        }
        const mMono = finestra.match(/MONORARI[AO][^\d]{0,15}([\d.,]+)/i);
        if (mMono) {
          const v = normalizzaPun(parseIT(mMono[1]));
          if (Number.isFinite(v)) per.MONO.push({ valore: v, raw: mMono[1], periodo: null, mese: null, anno: null, peso: null, fonte: 'tabella-compatta', riga: mMono[0] });
        }
      }
    }

    // Media del PUN di riferimento mensile quando la bolletta copre più mesi
    // e i consumi non sono separati: ponderata per giorni se noti, semplice altrimenti.
    const medio = (a) => {
      if (!a.length) return NaN;
      const vals = a.filter((r) => Number.isFinite(r.valore));
      if (!vals.length) return NaN;
      if (vals.length > 1) {
        const dettaglio = vals.map((r) => `${r.periodo || '?'} ${r.valore.toFixed(5)}`).join(' / ');
        if (vals.every((r) => Number.isFinite(r.peso) && r.peso > 0)) {
          const sp = vals.reduce((s, r) => s + r.peso, 0);
          avvisi.push(`PUN di riferimento mensile su più mesi (${dettaglio}): applicata media ponderata per giorni. Se la bolletta separa i consumi per mese, calcola i mesi uno alla volta.`);
          return vals.reduce((s, r) => s + r.valore * r.peso, 0) / sp;
        }
        avvisi.push(`Più valori trovati (${dettaglio}): usata media semplice. Se la bolletta separa i consumi per mese, calcola i mesi uno alla volta.`);
      }
      return vals.reduce((s, r) => s + r.valore, 0) / vals.length;
    };

    const punF1 = medio(per.F1), punF2 = medio(per.F2), punF3 = medio(per.F3);
    let punMono = medio(per.MONO);
    if (!Number.isFinite(punMono) && per.F23.length) {
      punMono = medio(per.F23);
      if (Number.isFinite(punMono)) avvisi.push('Trovato F23 (F2+F3 accorpate): usato come riferimento monorario/F23.');
    }

    const hasFasce = [punF1, punF2, punF3].filter(Number.isFinite).length >= 2;
    const hasMono = Number.isFinite(punMono);

    // Dettaglio per mese di riferimento (associa consumi del mese ↔ PUN del mese).
    // I record con stessa etichetta di periodo confluiscono nella stessa riga.
    const gruppi = new Map();
    const metti = (r, campo) => {
      const key = r.periodo || 'unico';
      if (!gruppi.has(key)) gruppi.set(key, { periodo: key, mese: null, anno: null, peso: null, ordine: gruppi.size });
      const g = gruppi.get(key);
      g[campo] = r.valore;
      if (g.mese == null && r.mese != null) { g.mese = r.mese; g.anno = r.anno; }
      if (g.peso == null && r.peso != null) g.peso = r.peso;
      if (!g.fonte) g.fonte = r.fonte;
    };
    for (const r of per.F1) metti(r, 'punF1');
    for (const r of per.F2) metti(r, 'punF2');
    for (const r of per.F3) metti(r, 'punF3');
    for (const r of per.MONO) metti(r, 'punMono');
    for (const r of per.F23) metti(r, 'punF23');
    const periodi = [...gruppi.values()].sort(
      (a, b) => (a.anno || 9999) - (b.anno || 9999) || (a.mese || 99) - (b.mese || 99) || a.ordine - b.ordine
    );

    let tipo = 'NON_TROVATO';
    if (hasFasce) tipo = 'FASCE';
    else if (hasMono) tipo = 'MONORARIO';
    else if ([punF1, punF2, punF3].filter(Number.isFinite).length === 1) {
      tipo = 'MONORARIO';
      punMono = [punF1, punF2, punF3].find(Number.isFinite);
      avvisi.push('Trovata una sola fascia: trattata come monoraria.');
    }

    // ── Offerta a prezzo fisso: il costo €/kWh di bolletta vince sulla formula PUN ──
    const ultimoVal = (a) => {
      const v = a.filter((r) => Number.isFinite(r.valore));
      return v.length ? v[v.length - 1].valore : NaN;
    };
    const prezziFissi = { F1: ultimoVal(fissi.F1), F2: ultimoVal(fissi.F2), F3: ultimoVal(fissi.F3), mono: ultimoVal(fissi.MONO) };
    const nFissi = [prezziFissi.F1, prezziFissi.F2, prezziFissi.F3, prezziFissi.mono].filter(Number.isFinite).length;
    const righeFisse = [...fissi.F1, ...fissi.F2, ...fissi.F3, ...fissi.MONO].map((r) => r.riga);

    let offerta = null;
    if (nFissi > 0 && (offertaFissaDichiarata || tipo === 'NON_TROVATO')) {
      offerta = 'FISSO';
      if (tipo === 'NON_TROVATO') {
        const nBand = [prezziFissi.F1, prezziFissi.F2, prezziFissi.F3].filter(Number.isFinite).length;
        tipo = nBand >= 2 ? 'FASCE' : 'MONORARIO';
      } else {
        avvisi.push('Offerta a prezzo fisso: in bolletta compare anche il PUN, ma il calcolo usa il costo fisso €/kWh.');
      }
      if (!offertaFissaDichiarata) avvisi.push('Prezzi €/kWh trovati senza dicitura "prezzo fisso": verifica che non siano valori PUN prima di usarli.');
    } else if (tipo !== 'NON_TROVATO') {
      offerta = 'INDICIZZATO_PUN';
    }

    if (tipo === 'NON_TROVATO') {
      if (righe.length === 0 && nFissi === 0) {
        avvisi.push('Nessuna riga con PUN né prezzi fissi €/kWh trovata. Cerca in bolletta "Indice di riferimento", "PUN medio mensile", "Prezzo energia €/kWh" o "Dettaglio prezzi" e incolla il testo con "Mostra testo".');
      } else {
        avvisi.push('Righe trovate ma senza valori validi in €/kWh o €/MWh. Cerca in bolletta la sezione "Indice di riferimento", "PUN medio mensile" o "Dettaglio prezzi" (spesso a fondo fattura) e incolla il testo con "Mostra testo".');
      }
    }

    return {
      tipo, offerta, prezziFissi,
      punF1: hasFasce ? punF1 : NaN,
      punF2: hasFasce ? punF2 : NaN,
      punF3: hasFasce ? punF3 : NaN,
      punMono: hasMono || tipo === 'MONORARIO' ? punMono : NaN,
      periodi, dettaglio: per,
      righe: righe.map((r) => r.line.trim()).filter(Boolean),
      righeFisse, avvisi,
    };
  }

  // ─── 3. CALCOLO MATERIA ENERGIA ────────────────────────────────────
  function prezzoDaPun(pun, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    return round5(pun * (1 + o.perdite) + o.capacity + o.dispacciamento + o.spread);
  }

  /**
   * Calcola l'intera bolletta da PUN di bolletta + consumi.
   *
   * @param {object} p
   *  consumi: {F1,F2,F3} oppure {mono} oppure {F1, F23}
   *  pun: output di estraiPUN() oppure {punF1,punF2,punF3,punMono}
   *  prezziFissi: override {F1,F2,F3,mono} — costo €/kWh usato così com'è
   *  canoneTV: € del periodo (fuori campo IVA) — bonusSociale: sconto € del periodo
   *  perdite: frazione (0.10 = 10%) — capacity, dispacciamento, spread in €/kWh
   *  kW, mesi, iva (0.10 o 0.22 oppure 10/22), capacity, dispacciamento, spread
   *
   * Se pun.offerta === 'FISSO' usa pun.prezziFissi senza formula PUN;
   * "Vendita Mono prezzo fisso" (unica cifra) vale per F1, F2 e F3.
   */
  function calcolaBolletta(p = {}) {
    const o = { ...DEFAULTS, ...p };
    const mesi = Math.max(1, Number(p.mesi) || 1);
    const kW = Number(p.kW ?? p.potenza ?? 0) || 0;
    let iva = Number(p.iva ?? DEFAULTS.iva);
    if (iva > 1) iva = iva / 100; // accetta sia 10 che 0.10

    const pun = p.pun || {};
    const c = p.consumi || {};

    // Normalizza consumi: supporta mono / F23 / F1+F2+F3
    let kF1 = Number(c.F1 || 0), kF2 = Number(c.F2 || 0), kF3 = Number(c.F3 || 0);
    if (Number(c.mono) > 0 && kF1 + kF2 + kF3 === 0) {
      // monorario: ripartisce tutto sul prezzo mono
    }
    if (Number(c.F23) > 0 && kF2 + kF3 === 0) {
      kF2 = 0; kF3 = Number(c.F23); // F23 accorpata → prezzo F2/F3 medio o mono
    }
    const kMono = Number(c.mono || 0);
    const kwhTot = round2(kF1 + kF2 + kF3 + kMono);

    const cap = Number(o.capacity ?? DEFAULTS.capacity);
    const disp = Number(o.dispacciamento ?? DEFAULTS.dispacciamento);
    const spread = Number(o.spread ?? DEFAULTS.spread);
    const perd = Number(o.perdite ?? DEFAULTS.perdite); // frazione: 0.10 = 10%
    const comp = { capacity: cap, dispacciamento: disp, spread, perdite: perd };

    let prezzoF1 = NaN, prezzoF2 = NaN, prezzoF3 = NaN, prezzoMono = NaN;
    let costoF1 = 0, costoF2 = 0, costoF3 = 0, costoMono = 0;

    // Prezzi fissi: da offerta a prezzo fisso (pun.offerta === 'FISSO')
    // oppure override esplicito p.prezziFissi = {F1,F2,F3,mono}.
    // Il costo fisso €/kWh si applica così com'è, senza formula PUN.
    // "Vendita Mono prezzo fisso" (unica cifra) vale per F1, F2 e F3.
    const pf = p.prezziFissi || (pun && pun.offerta === 'FISSO' ? pun.prezziFissi : null);
    const num = (v) => Number(v);
    const fin = (v) => Number.isFinite(num(v));
    let fontePrezzi = 'PUN';

    if (kMono > 0) {
      if (pf && fin(pf.mono)) {
        fontePrezzi = 'PREZZI_FISSI';
        prezzoMono = round5(num(pf.mono));
        costoMono = kMono * prezzoMono;
      } else {
        const pm = Number(pun.punMono);
        if (!Number.isFinite(pm)) throw new Error('Consumo monorario ma nessun prezzo (PUN monorario o fisso) trovato in bolletta.');
        prezzoMono = prezzoDaPun(pm, comp);
        costoMono = kMono * prezzoMono;
      }
    } else if (pf && (fin(pf.F1) || fin(pf.F2) || fin(pf.F3) || fin(pf.mono))) {
      fontePrezzi = 'PREZZI_FISSI';
      const fmono = fin(pf.mono) ? num(pf.mono) : null;
      const q1 = kF1 > 0 ? (fin(pf.F1) ? num(pf.F1) : fmono) : null;
      const q2 = kF2 > 0 ? (fin(pf.F2) ? num(pf.F2) : fmono) : null;
      const q3 = kF3 > 0 ? (fin(pf.F3) ? num(pf.F3) : fmono) : null;
      if (kF1 > 0 && q1 == null) throw new Error('Consumo F1 senza prezzo fisso F1 in bolletta (né "Vendita Mono prezzo fisso").');
      if (kF2 > 0 && q2 == null) throw new Error('Consumo F2 senza prezzo fisso F2 in bolletta (né "Vendita Mono prezzo fisso").');
      if (kF3 > 0 && q3 == null) throw new Error('Consumo F3 senza prezzo fisso F3 in bolletta (né "Vendita Mono prezzo fisso").');
      if (q1 != null) { prezzoF1 = round5(q1); costoF1 = kF1 * prezzoF1; }
      if (q2 != null) { prezzoF2 = round5(q2); costoF2 = kF2 * prezzoF2; }
      if (q3 != null) { prezzoF3 = round5(q3); costoF3 = kF3 * prezzoF3; }
    } else {
      // Se manca una fascia nel PUN ma c'è consumo, prova fallback F23/mono
      const fallback = Number.isFinite(Number(pun.punMono)) ? Number(pun.punMono)
        : Number.isFinite(Number(pun.punF3)) ? Number(pun.punF3) : NaN;
      const need = (k, v) => (k > 0 && !Number.isFinite(v) ? fallback : v);
      const p1 = need(kF1, Number(pun.punF1)), p2 = need(kF2, Number(pun.punF2)), p3 = need(kF3, Number(pun.punF3));
      if (kF1 > 0 && !Number.isFinite(p1)) throw new Error('Consumo F1 senza PUN F1 in bolletta.');
      if (kF2 > 0 && !Number.isFinite(p2)) throw new Error('Consumo F2 senza PUN F2 in bolletta.');
      if (kF3 > 0 && !Number.isFinite(p3)) throw new Error('Consumo F3 senza PUN F3 in bolletta.');
      if (Number.isFinite(p1)) { prezzoF1 = prezzoDaPun(p1, comp); costoF1 = kF1 * prezzoF1; }
      if (Number.isFinite(p2)) { prezzoF2 = prezzoDaPun(p2, comp); costoF2 = kF2 * prezzoF2; }
      if (Number.isFinite(p3)) { prezzoF3 = prezzoDaPun(p3, comp); costoF3 = kF3 * prezzoF3; }
    }

    const materiaEnergia = costoF1 + costoF2 + costoF3 + costoMono;

    // 4. Costi ARERA
    const reteVar = kwhTot * Number(o.reteVar ?? DEFAULTS.reteVar);
    const quotaPotenza = kW * Number(o.quotaPotenza ?? DEFAULTS.quotaPotenza) * mesi;
    const reteFissa = Number(o.reteFissa ?? DEFAULTS.reteFissa) * mesi;
    const pcv = Number(o.pcv ?? DEFAULTS.pcv) * mesi;
    const accisa = kwhTot * Number(o.accisa ?? DEFAULTS.accisa);

    const imponibile = materiaEnergia + reteVar + quotaPotenza + reteFissa + pcv + accisa;
    const importoIva = imponibile * iva;
    // Voci extra: canone TV fuori campo IVA (si somma dopo) e bonus sociale (sconto).
    // Passano identiche in simulazione e confronto: non alterano il risparmio, ma il totale sì.
    const canoneTV = Math.max(0, Number(p.canoneTV ?? 0) || 0);
    const bonusSociale = Math.max(0, Number(p.bonusSociale ?? 0) || 0);
    const totale = imponibile + importoIva - bonusSociale + canoneTV;

    return {
      input: { kwhTot, kW, mesi, iva, capacity: cap, perdite: perd, dispacciamento: disp, spread, canoneTV, bonusSociale },
      fontePrezzi,
      prezzi: { prezzoF1, prezzoF2, prezzoF3, prezzoMono },
      punUsato: {
        punF1: Number(pun.punF1 ?? NaN), punF2: Number(pun.punF2 ?? NaN),
        punF3: Number(pun.punF3 ?? NaN), punMono: Number(pun.punMono ?? NaN),
      },
      materiaEnergia: round2(materiaEnergia),
      dettaglioEnergia: {
        costoF1: round2(costoF1), costoF2: round2(costoF2),
        costoF3: round2(costoF3), costoMono: round2(costoMono),
      },
      reteVar: round2(reteVar), quotaPotenza: round2(quotaPotenza),
      reteFissa: round2(reteFissa), pcv: round2(pcv), accisa: round2(accisa),
      imponibile: round2(imponibile), importoIva: round2(importoIva),
      canoneTV: round2(canoneTV), bonusSociale: round2(bonusSociale),
      totale: round2(totale),
    };
  }

  /**
   * Voci extra di bolletta: canone TV e bonus sociale.
   * - Canone TV (abbonamento RAI, fuori campo IVA: si somma DOPO l'IVA).
   *   Se c'è una riga totale/annua usa quella, altrimenti somma le quote (rate/mesi).
   * - Bonus sociale (sconto, spesso con segno meno): vale il valore assoluto maggiore
   *   (evita di contarlo due volte se compare in dettaglio + riepilogo).
   */
  function estraiVociExtra(testo) {
    const lines = String(testo || '').replace(/\r/g, '').split('\n');
    const righeCanone = lines.filter((l) =>
      /canone\s+(tv|rai)|canone\s+di\s+abbonamento|abbonamento\s+(tv|rai)|canone\s+televisione/i.test(l));
    const righeBonus = lines.filter((l) =>
      /bonus\s+sociale|bonus\s+elettrico|bonus\s+.*disagio|bonus\s+famiglia|sconto\s+bonus/i.test(l));

    const importo = (line) => {
      // ultimo numero con decimali; fallback: intero seguito da € ("Canone TV 90 €")
      const nums = numeriInRiga(line).map((n) => parseIT(n.raw)).filter((v) => Number.isFinite(v) && v > 0);
      if (nums.length) return nums[nums.length - 1];
      const m = String(line).match(/(\d+)\s*(?:€|EUR)/i);
      return m ? parseIT(m[1]) : NaN;
    };

    let canoneTV = 0;
    if (righeCanone.length) {
      const totali = righeCanone.filter((l) => /totale|complessivo|annuo|anno\s+20/i.test(l));
      if (totali.length) {
        const v = totali.map(importo).filter((x) => Number.isFinite(x));
        canoneTV = v.length ? v[v.length - 1] : 0;
      } else {
        const quote = righeCanone.filter((l) => /rata|rate|quota|mese|mensile|mensilit|periodo/i.test(l));
        const base = quote.length ? quote : righeCanone;
        canoneTV = base.map(importo).filter((x) => Number.isFinite(x)).reduce((s, v) => s + v, 0);
      }
    }

    let bonusSociale = 0;
    if (righeBonus.length) {
      const vals = righeBonus.map(importo).filter((x) => Number.isFinite(x));
      if (vals.length) bonusSociale = Math.max(...vals);
    }
    return {
      canoneTV: round2(canoneTV), bonusSociale: round2(bonusSociale),
      righeCanone: righeCanone.map((l) => l.trim()).filter(Boolean),
      righeBonus: righeBonus.map((l) => l.trim()).filter(Boolean),
    };
  }

  /**
   * Intestatario e indirizzo di fornitura dalla bolletta.
   * Cerca etichette ("Intestatario:", "Cliente:", "Titolare:…") e righe stradali
   * ("Via … 12" + eventuale "CAP Città"). Sempre verificabili/modificabili a video.
   */
  function estraiIntestatario(testo) {
    const t = String(testo || '').replace(/\r/g, '');
    const pulisci = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 80);

    let intestatario = '';
    const pats = [
      /(?:intestatario|titolare\s+dell['’]?utenza|titolare\s+della\s+bolletta|nominativo|contratto\s+intestato\s+a|utenza\s+intestata\s+a)[\s:]+([^\n]{3,80})/i,
      /(?:cliente|contraente|committente|sig\.(?:ra)?|spett\.le)\s*:\s*([^\n]{3,80})/i,
    ];
    for (const p of pats) {
      const m = t.match(p);
      if (m) {
        // taglia code aggiuntive sulla stessa riga ("… Codice fiscale RSS…")
        const v = pulisci(m[1].split(/\s+(?:codice|p\.?\s*iva|c\.?\s*f\.?|pod|pdr|tel|email|fattura)\b/i)[0]);
        if (v && !/^\d+$/.test(v) && v.length >= 3) { intestatario = v; break; }
      }
    }

    let indirizzo = '';
    const pInd = /(?:indirizzo\s+(?:di\s+)?(?:fornitura|consegna|utenza)|luogo\s+di\s+(?:fornitura|consegna)|punto\s+di\s+fornitura|residenza|domicilio)[\s:]+([^\n]{3,90})/i;
    const mInd = t.match(pInd);
    if (mInd) indirizzo = pulisci(mInd[1]);
    if (!indirizzo) {
      const mVia = t.match(/(?:^|\n)\s*((?:via|viale|v\.le|piazza|p\.zza|corso|contrada|strada|localit[àa]|frazione|vicolo|largo)\b[^\n]{3,80})/i);
      if (mVia) indirizzo = pulisci(mVia[1]);
    }
    if (indirizzo) {
      const mCap = t.match(/(?:^|\n)\s*(\d{5})\s+([A-Za-zÀ-ÿ'’\-\s]{2,50}?)(?=\n|$)/);
      if (mCap && !indirizzo.includes(mCap[1])) indirizzo = `${indirizzo}, ${mCap[1]} ${pulisci(mCap[2])}`;
    }
    return { intestatario, indirizzo };
  }

  /** Media ponderata PUN multi-mese quando i consumi non sono separati. */
  function punMedioPonderato(periodi, pesi) {
    // periodi: [{punF1,...}], pesi: [giorniMese1, giorniMese2...] o null →
    // usa il campo peso del periodo, altrimenti media semplice
    const w = pesi && pesi.length === periodi.length ? pesi : periodi.map((p) => p.peso || 1);
    const avg = (key) => {
      let s = 0, sw = 0;
      periodi.forEach((p, i) => {
        if (Number.isFinite(p[key])) { s += p[key] * w[i]; sw += w[i]; }
      });
      return sw ? s / sw : NaN; // nota: pesi riscalati sui soli mesi validi
    };
    return { punF1: avg('punF1'), punF2: avg('punF2'), punF3: avg('punF3'), punMono: avg('punMono'), punF23: avg('punF23') };
  }

  return { DEFAULTS, parseIT, normalizzaPun, estraiPUN, estraiVociExtra, estraiIntestatario, prezzoDaPun, calcolaBolletta, punMedioPonderato };
});

// ─── CLI (solo Node) ──────────────────────────────────────────────────
if (typeof module !== 'undefined' && require.main === module) {
  const fs = require('fs');
  const lib = module.exports;
  const args = process.argv.slice(2);

  const help = () => console.log(
`Uso:
  node calcolo-pun.js --test                    esegue i 3 casi di verifica
  node calcolo-pun.js --file testo.txt          estrae PUN + calcola (consumi via --kwh)
  node calcolo-pun.js --text "PUN F1 0,12 ..."  idem da stringa
Opzioni: --f1 100 --f2 80 --f3 120 --mono 0 --kw 3 --mesi 2 --iva 10
         --disp 0.008 --spread 0.018 --capacity 0.006288`
  );

  const get = (k, d) => {
    const i = args.indexOf(k);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
  };

  if (args.includes('--help') || args.length === 0) help();

  if (args.includes('--test')) {
    let ok = 0, ko = 0;
    const assert = (nome, cond, extra = '') => {
      if (cond) { ok++; console.log(`  ✓ ${nome}`); }
      else { ko++; console.log(`  ✗ ${nome} ${extra}`); }
    };
    console.log('TEST 1 — bioraria da specifica');
    const t1 = `Indice di riferimento: PUN - F1 0,12500 €/kWh F2 0,13500 €/kWh F3 0,11000 €/kWh periodo 01/06-30/06`;
    const pun1 = lib.estraiPUN(t1);
    assert('tipo FASCE', pun1.tipo === 'FASCE', JSON.stringify(pun1));
    const r1 = lib.calcolaBolletta({ consumi: { F1: 100, F2: 80, F3: 120 }, pun: pun1, kW: 3, mesi: 1, iva: 10 });
    // Prezzo_F1 atteso = 0.125*1.1+0.006288+0.008+0.018 = 0.169788
    assert('prezzo F1 ≈ 0.16979', Math.abs(r1.prezzi.prezzoF1 - 0.16979) < 0.00002, String(r1.prezzi.prezzoF1));
    assert('totale > imponibile', r1.totale > r1.imponibile, `${r1.totale} vs ${r1.imponibile}`);
    console.log(`    materia=${r1.materiaEnergia} reteVar=${r1.reteVar} pot=${r1.quotaPotenza} fissa=${r1.reteFissa} pcv=${r1.pcv} accisa=${r1.accisa} tot=${r1.totale}`);

    console.log('TEST 2 — monoraria in €/MWh (112,45 → 0,11245)');
    const t2 = 'Prezzo Unico Nazionale MONORARIA 112,45 €/MWh';
    const pun2 = lib.estraiPUN(t2);
    assert('tipo MONORARIO', pun2.tipo === 'MONORARIO', JSON.stringify(pun2));
    assert('punMono ≈ 0.11245', Math.abs(pun2.punMono - 0.11245) < 0.00001, String(pun2.punMono));
    const r2 = lib.calcolaBolletta({ consumi: { mono: 300 }, pun: pun2, kW: 3, mesi: 2, iva: 10 });
    assert('kwh 300', r2.input.kwhTot === 300, String(r2.input.kwhTot));

    console.log('TEST 3 — bimestrale giugno+luglio, media ponderata per giorni');
    const t3 = 'PUN F1 01/06-30/06 0,12000 €/kWh\nPUN F1 01/07-31/07 0,13000 €/kWh\nPUN F2 01/06-30/06 0,11000\nPUN F2 01/07-31/07 0,12000\nPUN F3 01/06-30/06 0,10000\nPUN F3 01/07-31/07 0,10500';
    const pun3 = lib.estraiPUN(t3);
    const att3 = (0.12 * 30 + 0.13 * 31) / 61;
    assert('media F1 ponderata ≈ 0.12508', Math.abs(pun3.punF1 - att3) < 1e-9, String(pun3.punF1));
    const medio = lib.punMedioPonderato(pun3.periodi, [30, 31]);
    assert('punMedioPonderato F1 ≈ 0.12508', Math.abs(medio.punF1 - att3) < 1e-9, String(medio.punF1));

    console.log('TEST 4 — tabella mensile €/MWh (header PUN + righe senza parola PUN)');
    const t4 = ['Indice di riferimento: PUN medio mensile (fonte GME) - valori in €/MWh',
      'MESE F1 F2 F3',
      'giugno 2025 104,52 118,30 96,10',
      'luglio 2025 112,40 121,05 99,75',
      'Totale fattura 156,20 €'].join('\n');
    const pun4 = lib.estraiPUN(t4);
    assert('tipo FASCE', pun4.tipo === 'FASCE', JSON.stringify(pun4.periodi));
    assert('2 mesi distinti', pun4.periodi.length === 2, String(pun4.periodi.length));
    assert('giugno F1 = 0.10452', Math.abs((pun4.periodi[0] || {}).punF1 - 0.10452) < 1e-9, JSON.stringify(pun4.periodi[0]));
    assert('luglio F3 = 0.09975', Math.abs((pun4.periodi[1] || {}).punF3 - 0.09975) < 1e-9, JSON.stringify(pun4.periodi[1]));
    assert('totale fattura NON preso come PUN', pun4.periodi.every((p) => ![p.punF1, p.punF2, p.punF3].some((v) => Math.abs(v - 0.1562) < 1e-9)), JSON.stringify(pun4.periodi));

    console.log('TEST 5 — PUN mensile su righe F1/F2/F3 senza mese (eredita mese ancora)');
    const t5 = ['PUN - Prezzo Unico Nazionale del mese di giugno 2025 (fonte GME)',
      'F1: 0,10452 €/kWh',
      'F2: 0,11830 €/kWh',
      'F3: 0,09610 €/kWh',
      'Energia attiva F1 giugno 120 kWh'].join('\n');
    const pun5 = lib.estraiPUN(t5);
    assert('tipo FASCE', pun5.tipo === 'FASCE', JSON.stringify(pun5.periodi));
    assert('periodo giugno 2025', (pun5.periodi[0] || {}).periodo === 'giugno 2025', JSON.stringify(pun5.periodi));
    assert('consumo 120 kWh NON preso', Math.abs(pun5.punF1 - 0.10452) < 1e-9, String(pun5.punF1));

    console.log('TEST 6 — monorario mensile "PUN del mese di luglio 2025"');
    const t6 = 'PUN del mese di luglio 2025: 0,11234 €/kWh - periodo 01/07/2025-31/07/2025';
    const pun6 = lib.estraiPUN(t6);
    assert('tipo MONORARIO', pun6.tipo === 'MONORARIO', JSON.stringify(pun6));
    assert('punMono = 0.11234', Math.abs(pun6.punMono - 0.11234) < 1e-9, String(pun6.punMono));

    console.log('TEST 7 — offerta a prezzo fisso per fasce (niente formula PUN)');
    const t7 = ['Offerta a prezzo fisso fino al 31/12/2025',
      'Prezzo energia F1 0,14500 €/kWh',
      'Prezzo energia F2 0,15500 €/kWh',
      'Prezzo energia F3 0,13500 €/kWh'].join('\n');
    const pun7 = lib.estraiPUN(t7);
    assert('offerta FISSO', pun7.offerta === 'FISSO', JSON.stringify({ offerta: pun7.offerta, prezziFissi: pun7.prezziFissi }));
    const r7 = lib.calcolaBolletta({ consumi: { F1: 100, F2: 80, F3: 120 }, pun: pun7, kW: 3, mesi: 1, iva: 10 });
    assert('fonte PREZZI_FISSI', r7.fontePrezzi === 'PREZZI_FISSI', r7.fontePrezzi);
    // materia attesa = 100*0.145 + 80*0.155 + 120*0.135 = 43.10
    assert('materia = 43.10', Math.abs(r7.materiaEnergia - 43.10) < 0.01, String(r7.materiaEnergia));

    console.log('TEST 8 — "Vendita Mono prezzo fisso": unica cifra per F1/F2/F3');
    const t8 = ['Dettaglio prezzi - Vendita Mono prezzo fisso',
      'Vendita Mono prezzo fisso 0,14200 €/kWh',
      'Potenza contrattuale 3 kW'].join('\n');
    const pun8 = lib.estraiPUN(t8);
    assert('offerta FISSO', pun8.offerta === 'FISSO', JSON.stringify({ offerta: pun8.offerta, prezziFissi: pun8.prezziFissi }));
    assert('mono fisso = 0.142', Math.abs(pun8.prezziFissi.mono - 0.142) < 1e-9, JSON.stringify(pun8.prezziFissi));
    const r8 = lib.calcolaBolletta({ consumi: { F1: 100, F2: 80, F3: 120 }, pun: pun8, kW: 3, mesi: 1, iva: 10 });
    // materia attesa = 300 * 0.142 = 42.60
    assert('materia = 42.60', Math.abs(r8.materiaEnergia - 42.60) < 0.01, String(r8.materiaEnergia));
    assert('prezzi F1=F2=F3', r8.prezzi.prezzoF1 === r8.prezzi.prezzoF2 && r8.prezzi.prezzoF2 === r8.prezzi.prezzoF3, JSON.stringify(r8.prezzi));

    console.log('TEST 9 — coerenza: stessi parametri = stesso totale (punto 3 = verifica report)');
    const base9 = { consumi: { F1: 100, F2: 80, F3: 120 }, pun: { offerta: 'INDICIZZATO_PUN', punF1: 0.12, punF2: 0.11, punF3: 0.10 }, kW: 3, mesi: 1, iva: 10 };
    const a9 = lib.calcolaBolletta({ ...base9, spread: 0.018, dispacciamento: 0.008 });
    const b9 = lib.calcolaBolletta({ ...base9, spread: 0.018, dispacciamento: 0.008 });
    assert('stessi parametri = stesso totale', a9.totale === b9.totale, `${a9.totale} vs ${b9.totale}`);
    const c9 = lib.calcolaBolletta({ ...base9, spread: 0.012, dispacciamento: 0.003 });
    assert('listino diverso = totale diverso (la differenza è il risparmio)', c9.totale !== a9.totale, `${c9.totale} vs ${a9.totale}`);

    console.log('TEST 10 — canone TV + bonus sociale in estrazione e totale');
    const t10 = ['Canone di abbonamento TV - 2 rate mensili da 9,00 €',
      'Totale canone TV 18,00 €',
      'Bonus sociale elettrico -45,00 €',
      'Totale bolletta 200,00 €'].join('\n');
    const v10 = lib.estraiVociExtra(t10);
    assert('canone TV = 18 (riga totale, non somma doppia)', v10.canoneTV === 18, JSON.stringify(v10));
    assert('bonus sociale = 45 (valore assoluto)', v10.bonusSociale === 45, JSON.stringify(v10));
    const r10 = lib.calcolaBolletta({ ...base9, spread: 0.012, dispacciamento: 0.003, canoneTV: 18, bonusSociale: 45 });
    assert('totale = imponibile+IVA-45+18', Math.abs(r10.totale - (r10.imponibile + r10.importoIva - 45 + 18)) < 0.015, String(r10.totale));

    console.log('TEST 11 — intestatario + indirizzo fornitura');
    const t11 = ['Fattura energia elettrica n. 12345',
      'Intestatario: Mario Rossi Codice fiscale RSSMRA80A01H501U',
      'Indirizzo di fornitura: Via delle Rose 12',
      '00100 Roma RM',
      'PUN F1 0,12000 €/kWh'].join('\n');
    const i11 = lib.estraiIntestatario(t11);
    assert('intestatario senza codice fiscale', i11.intestatario === 'Mario Rossi', JSON.stringify(i11));
    assert('indirizzo con via e città', /via delle rose/i.test(i11.indirizzo) && /00100 roma/i.test(i11.indirizzo), JSON.stringify(i11));

    console.log('TEST 12 — tutte le voci formula modificabili (perdite comprese)');
    const p12 = lib.prezzoDaPun(0.10, { capacity: 0.006288, dispacciamento: 0.003, spread: 0.012, perdite: 0 });
    assert('perdite 0 → 0.12129', Math.abs(p12 - 0.12129) < 1e-5, String(p12));
    const r12 = lib.calcolaBolletta({ ...base9, spread: 0.012, dispacciamento: 0.003, perdite: 0 });
    assert('perdite in input', r12.input.perdite === 0, JSON.stringify(r12.input));
    assert('prezzo F1 senza perdite', Math.abs(r12.prezzi.prezzoF1 - (0.12 + 0.006288 + 0.003 + 0.012)) < 1e-5, String(r12.prezzi.prezzoF1));

    console.log(`\nRisultato: ${ok} ok, ${ko} errori`);
    process.exit(ko ? 1 : 0);
  }

  if (args.includes('--file') || args.includes('--text')) {
    let testo = '';
    if (args.includes('--file')) testo = fs.readFileSync(get('--file'), 'utf8');
    else testo = get('--text', '');
    // Se è un PDF e pdf-parse è installato, prova a estrarre il testo
    if (args.includes('--file') && /\.pdf$/i.test(get('--file', ''))) {
      try {
        const pdfParse = require('pdf-parse');
        pdfParse(fs.readFileSync(get('--file'))).then((d) => elabora(d.text)).catch((e) => {
          console.error('PDF non leggibile, installa pdf-parse (npm i pdf-parse) oppure incolla il testo. Errore:', e.message);
          process.exit(1);
        });
      } catch {
        console.error('File PDF: installa "npm i pdf-parse" oppure usa il tool HTML (pdf.js) e incolla il testo con --text.');
        process.exit(1);
      }
    } else elabora(testo);

    function elabora(txt) {
      const pun = lib.estraiPUN(txt);
      console.log('— PUN estratto dalla bolletta —');
      console.log(JSON.stringify({ tipo: pun.tipo, punF1: pun.punF1, punF2: pun.punF2, punF3: pun.punF3, punMono: pun.punMono, avvisi: pun.avvisi }, null, 2));
      if (pun.tipo === 'NON_TROVATO') process.exit(2);
      const r = lib.calcolaBolletta({
        consumi: {
          F1: Number(get('--f1', 0)), F2: Number(get('--f2', 0)), F3: Number(get('--f3', 0)),
          mono: Number(get('--mono', 0)),
        },
        pun, kW: Number(get('--kw', 3)), mesi: Number(get('--mesi', 1)), iva: Number(get('--iva', 10)),
        dispacciamento: Number(get('--disp', lib.DEFAULTS.dispacciamento)),
        spread: Number(get('--spread', lib.DEFAULTS.spread)),
      });
      console.log('— Calcolo —');
      console.log(JSON.stringify(r, null, 2));
    }
  }
}
