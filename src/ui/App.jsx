import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CATALOG, priceForQuantityPaise } from '../../shared/catalog.js';
import { applyCorrection, parseSpokenOrder } from '../../shared/order-parser.js';
import { apiUrl } from '../api.js';

const MAX_RECORD_SECONDS = 25;

function formatMoney(paise) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format((paise || 0) / 100);
}

function formatQuantity(quantityMilli) {
  if (!Number.isInteger(quantityMilli)) return '';
  return String(quantityMilli / 1000);
}

function describeDate(iso) {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

async function responseError(response, fallback) {
  try {
    const payload = await response.json();
    return payload.error || fallback;
  } catch {
    return fallback;
  }
}

function Icon({ name, size = 20 }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  if (name === 'mic') return <svg {...common}><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3m-4 0h8"/></svg>;
  if (name === 'receipt') return <svg {...common}><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6m-6 4h6m-6 4h3"/></svg>;
  if (name === 'plus') return <svg {...common}><path d="M12 5v14M5 12h14"/></svg>;
  if (name === 'trash') return <svg {...common}><path d="M4 7h16M10 11v6m4-6v6M5 7l1 14h12l1-14M9 7V4h6v3"/></svg>;
  if (name === 'play') return <svg {...common}><path d="m8 5 11 7-11 7z" fill="currentColor" stroke="none"/></svg>;
  if (name === 'check') return <svg {...common}><path d="m5 12 4 4L19 6"/></svg>;
  if (name === 'arrow') return <svg {...common}><path d="M5 12h14m-6-6 6 6-6 6"/></svg>;
  if (name === 'clock') return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>;
  if (name === 'spark') return <svg {...common}><path d="m12 3 1.6 5.3L19 10l-5.4 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Zm7 12 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/></svg>;
  return null;
}

function App() {
  const [view, setView] = useState('order');
  const [speechConfigured, setSpeechConfigured] = useState(null);
  const [maxAudioBytes, setMaxAudioBytes] = useState(8 * 1024 * 1024);
  const [history, setHistory] = useState([]);
  const [historyError, setHistoryError] = useState('');
  const [transcript, setTranscript] = useState('');
  const [detectedLanguage, setDetectedLanguage] = useState('');
  const [draft, setDraft] = useState(null);
  const [pendingCorrection, setPendingCorrection] = useState('');
  const [recordPurpose, setRecordPurpose] = useState('order');
  const [recordState, setRecordState] = useState('idle');
  const [recordSeconds, setRecordSeconds] = useState(MAX_RECORD_SECONDS);
  const [speechError, setSpeechError] = useState('');
  const [readbackState, setReadbackState] = useState('idle');
  const [readbackError, setReadbackError] = useState('');
  const [readbackComplete, setReadbackComplete] = useState(false);
  const [readbackToken, setReadbackToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [selectedReceipt, setSelectedReceipt] = useState(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const chunksRef = useRef([]);
  const audioRef = useRef(null);
  const saveInFlightRef = useRef(false);
  const readbackInFlightRef = useRef(false);

  useEffect(() => {
    fetch(apiUrl('/api/health'))
      .then((response) => response.json())
      .then((payload) => {
        setSpeechConfigured(Boolean(payload.speechConfigured));
        if (Number.isInteger(payload.maxAudioBytes) && payload.maxAudioBytes > 0) setMaxAudioBytes(payload.maxAudioBytes);
      })
      .catch(() => setSpeechConfigured(false));
    loadHistory();
  }, []);

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (audioRef.current) {
      audioRef.current.pause();
      URL.revokeObjectURL(audioRef.current.src);
    }
  }, []);

  async function loadHistory() {
    setIsLoadingHistory(true);
    setHistoryError('');
    try {
      const response = await fetch(apiUrl('/api/orders'));
      if (!response.ok) throw new Error(await responseError(response, 'Order history could not be loaded.'));
      const payload = await response.json();
      setHistory(Array.isArray(payload.orders) ? payload.orders : []);
    } catch (error) {
      setHistoryError(error.message || 'Order history could not be loaded.');
    } finally {
      setIsLoadingHistory(false);
    }
  }

  const resetReadback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      URL.revokeObjectURL(audioRef.current.src);
      audioRef.current = null;
    }
    setReadbackComplete(false);
    setReadbackToken('');
    setReadbackError('');
    setReadbackState('idle');
    setSaveError('');
  }, []);

  const activeIssues = useMemo(() => {
    if (!draft) return [];
    return draft.issues.filter((issue) => !issue.reviewed);
  }, [draft]);

  const liveItems = useMemo(() => (draft?.items ?? []).map((item) => {
    const product = CATALOG.find((entry) => entry.id === item.productId);
    return {
      ...item,
      product,
      lineTotalPaise: product && Number.isInteger(item.quantityMilli) && item.quantityMilli > 0 && item.unit === product.baseUnit
        ? priceForQuantityPaise(product, item.quantityMilli)
        : 0,
    };
  }), [draft]);
  const totalPaise = liveItems.reduce((total, item) => total + item.lineTotalPaise, 0);
  const incompleteItems = liveItems.filter((item) => !item.product || !Number.isInteger(item.quantityMilli) || item.quantityMilli < 1 || item.unit !== item.product.baseUnit);
  const orderReady = Boolean(draft && liveItems.length > 0 && incompleteItems.length === 0 && activeIssues.length === 0);

  function changeDraftItems(change) {
    setDraft((current) => {
      if (!current) return current;
      return { ...current, items: change(current.items) };
    });
    resetReadback();
  }

  function updateLine(index, updates) {
    changeDraftItems((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, ...updates } : item));
  }

  function markIssueReviewed(issueId) {
    setDraft((current) => current ? ({ ...current, issues: current.issues.map((issue) => issue.id === issueId ? { ...issue, reviewed: true } : issue) }) : current);
    resetReadback();
  }

  function addManualItem() {
    const product = CATALOG.find((candidate) => !draft?.items.some((item) => item.productId === candidate.id));
    if (!product) return;
    changeDraftItems((items) => [...items, { productId: product.id, quantityMilli: null, unit: product.baseUnit, manual: true }]);
  }

  function removeLine(index) {
    changeDraftItems((items) => items.filter((_item, itemIndex) => itemIndex !== index));
  }

  function startNewOrder() {
    if (audioRef.current) {
      audioRef.current.pause();
      URL.revokeObjectURL(audioRef.current.src);
      audioRef.current = null;
    }
    setView('order');
    setTranscript('');
    setDetectedLanguage('');
    setDraft(null);
    setPendingCorrection('');
    setSpeechError('');
    setRecordState('idle');
    setReceipt(null);
    setSelectedReceipt(null);
    resetReadback();
  }

  function buildOrder() {
    if (!transcript.trim()) {
      setSpeechError('Add a transcript before building the order.');
      return;
    }
    const parsed = parseSpokenOrder(transcript);
    setDraft(parsed);
    setPendingCorrection('');
    resetReadback();
  }

  function applySpokenCorrection() {
    if (!pendingCorrection.trim() || !draft) return;
    const parsed = applyCorrection(pendingCorrection, draft.items);
    setDraft((current) => current ? ({ ...parsed, issues: [...current.issues, ...parsed.issues] }) : parsed);
    setPendingCorrection('');
    resetReadback();
  }

  function wavFromAudioBuffer(audioBuffer) {
    const targetRate = 16000;
    const outputLength = Math.floor(audioBuffer.duration * targetRate);
    if (outputLength < 1600) throw new Error('The recording was too short. Please record at least a moment of speech.');
    const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, index) => audioBuffer.getChannelData(index));
    const output = new ArrayBuffer(44 + outputLength * 2);
    const view = new DataView(output);
    const writeText = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
    writeText(0, 'RIFF');
    view.setUint32(4, 36 + outputLength * 2, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, 'data');
    view.setUint32(40, outputLength * 2, true);
    for (let index = 0; index < outputLength; index += 1) {
      const sourcePosition = index * audioBuffer.sampleRate / targetRate;
      const before = Math.floor(sourcePosition);
      const after = Math.min(before + 1, channels[0].length - 1);
      const fraction = sourcePosition - before;
      let sample = 0;
      for (const channel of channels) sample += channel[before] * (1 - fraction) + channel[after] * fraction;
      sample /= channels.length;
      const clipped = Math.max(-1, Math.min(1, sample));
      view.setInt16(44 + index * 2, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true);
    }
    return new Blob([output], { type: 'audio/wav' });
  }

  async function transcodeRecording(blob) {
    if (!blob.size) throw new Error('The recording was empty. Please try again.');
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('This browser cannot convert the recording to Gnani’s supported WAV format. Try a recent version of Chrome or Edge.');
    const context = new AudioContextClass();
    try {
      const audioBuffer = await context.decodeAudioData(await blob.arrayBuffer());
      if (audioBuffer.duration > 30) throw new Error('This recording is longer than Gnani’s 30 second limit. Please record a shorter order.');
      return wavFromAudioBuffer(audioBuffer);
    } catch (error) {
      if (error.message?.includes('longer') || error.message?.includes('shorter')) throw error;
      throw new Error('This browser could not decode its recording format. Please try another supported browser.');
    } finally {
      await context.close().catch(() => {});
    }
  }

  async function transcribe(blob, purpose) {
    setRecordState('processing');
    setSpeechError('Converting audio to WAV and sending it to Gnani…');
    try {
      const wav = await transcodeRecording(blob);
      if (wav.size > maxAudioBytes) throw new Error('This recording is too large to upload. Please record a shorter order.');
      const form = new FormData();
      form.append('audio_file', wav, 'order.wav');
      const response = await fetch(apiUrl('/api/transcribe'), { method: 'POST', body: form });
      if (!response.ok) throw new Error(await responseError(response, 'The recording could not be transcribed. Please try again.'));
      const payload = await response.json();
      const actualTranscript = payload.transcript?.trim();
      if (!actualTranscript) throw new Error('No clear speech was detected. Please record the order again.');
      setDetectedLanguage(payload.detectedLanguage || 'Language not detected');
      setSpeechError('');
      if (purpose === 'correction') setPendingCorrection(actualTranscript);
      else setTranscript(actualTranscript);
      setRecordState('idle');
    } catch (error) {
      setSpeechError(error.message || 'Speech processing failed. You can retry once you are ready.');
      setRecordState('error');
    }
  }

  async function beginRecording(purpose) {
    setSpeechError('');
    if (!speechConfigured) {
      setSpeechError('Gnani speech is not configured. Contact the shop administrator. No sample transcript will be substituted.');
      setRecordState('error');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setSpeechError('This browser does not support microphone recording. Try a recent version of Chrome or Edge.');
      setRecordState('error');
      return;
    }
    setRecordPurpose(purpose);
    setRecordState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      streamRef.current = stream;
      const preferredTypes = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
      const mimeType = preferredTypes.find((type) => MediaRecorder.isTypeSupported?.(type));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      setRecordSeconds(MAX_RECORD_SECONDS);
      setRecordState('recording');
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onerror = () => {
        setSpeechError('The browser recording failed. Please try recording again.');
        setRecordState('error');
        stream.getTracks().forEach((track) => track.stop());
      };
      recorder.onstop = () => {
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = null;
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'application/octet-stream' });
        void transcribe(blob, purpose);
      };
      recorder.start(250);
      timerRef.current = setInterval(() => {
        setRecordSeconds((remaining) => {
          if (remaining <= 1) {
            clearInterval(timerRef.current);
            timerRef.current = null;
            if (recorder.state === 'recording') recorder.stop();
            return 0;
          }
          return remaining - 1;
        });
      }, 1000);
    } catch (error) {
      const message = error.name === 'NotAllowedError' || error.name === 'SecurityError'
        ? 'Microphone permission was denied. Allow microphone access in your browser settings and try again.'
        : error.name === 'NotFoundError'
          ? 'No microphone was found. Connect or enable a microphone and try again.'
          : 'The microphone could not be started. Check its connection and browser permission.';
      setSpeechError(message);
      setRecordState('error');
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }

  async function requestReadback() {
    if (!orderReady || readbackInFlightRef.current || readbackState === 'loading' || readbackState === 'playing') return;
    readbackInFlightRef.current = true;
    setReadbackState('loading');
    setReadbackError('');
    setReadbackComplete(false);
    setReadbackToken('');
    try {
      const response = await fetch(apiUrl('/api/tts/readback'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: liveItems.map(({ productId, quantityMilli, unit }) => ({ productId, quantityMilli, unit })) }),
      });
      if (!response.ok) throw new Error(await responseError(response, 'Gnani could not read the order back. Nothing was saved.'));
      const token = response.headers.get('x-readback-token');
      const audioBlob = await response.blob();
      if (!token || !audioBlob.size || !audioBlob.type.startsWith('audio/')) throw new Error('Gnani returned an unsupported audio response. Nothing was saved.');
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      audioRef.current = audio;
      setReadbackToken(token);
      setReadbackState('playing');
      audio.onended = () => {
        setReadbackComplete(true);
        setReadbackState('complete');
        URL.revokeObjectURL(audioUrl);
        audioRef.current = null;
      };
      audio.onerror = () => {
        setReadbackError('Order audio could not be played. Retry the read-back before saving.');
        setReadbackState('error');
        URL.revokeObjectURL(audioUrl);
        audioRef.current = null;
      };
      await audio.play();
    } catch (error) {
      setReadbackError(error.message || 'Gnani read-back failed. Nothing was saved.');
      setReadbackState('error');
    } finally {
      readbackInFlightRef.current = false;
    }
  }

  async function confirmAndSave() {
    if (!orderReady || !readbackComplete || !readbackToken || saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    setSaving(true);
    setSaveError('');
    try {
      const response = await fetch(apiUrl('/api/orders'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: liveItems.map(({ productId, quantityMilli, unit }) => ({ productId, quantityMilli, unit })),
          confirmed: true,
          readbackToken,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, 'This order could not be saved. Please review it and try again.'));
      const payload = await response.json();
      setReceipt(payload.order);
      setHistory((current) => [payload.order, ...current.filter((order) => order.id !== payload.order.id)]);
      setReadbackToken('');
      setReadbackComplete(false);
    } catch (error) {
      setSaveError(error.message || 'This order could not be saved.');
    } finally {
      setSaving(false);
      saveInFlightRef.current = false;
    }
  }

  const isRecording = recordState === 'recording';
  const busyProcessing = recordState === 'requesting' || recordState === 'processing';

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => { setView('order'); setSelectedReceipt(null); }} aria-label="BolBahi home">
          <span className="brand-mark">ब</span>
          <span className="brand-name">Bol<span>Bahi</span></span>
        </button>
        <div className="topbar-right">
          <div className="customer-chip"><span className="customer-avatar">W</span><span><strong>Walk-in #104</strong><small>Synthetic demo customer</small></span></div>
          <span className={`speech-status ${speechConfigured === false ? 'is-offline' : ''}`}><i />{speechConfigured === null ? 'Checking speech' : speechConfigured ? 'Gnani speech ready' : 'Speech not configured'}</span>
        </div>
      </header>

      <main className="page-wrap">
        <section className="page-heading">
          <div>
            <p className="eyebrow">YOUR COUNTER, IN SYNC</p>
            <h1>{view === 'history' ? 'Order history' : receipt ? 'Order confirmed' : 'Take a voice order'}</h1>
            <p className="heading-copy">A simpler way to hear, check, and confirm every kirana order.</p>
          </div>
          <div className="heading-badges"><span className="demo-badge"><span>₹</span> Demo catalogue prices</span><button className={`nav-tab ${view === 'history' ? 'active' : ''}`} onClick={() => { setView(view === 'history' ? 'order' : 'history'); setSelectedReceipt(null); if (view !== 'history') loadHistory(); }}><Icon name="receipt" size={17} />{view === 'history' ? 'New order' : `Orders${history.length ? ` · ${history.length}` : ''}`}</button></div>
        </section>

        {view === 'history' ? (
          <HistoryView orders={history} loading={isLoadingHistory} error={historyError} selectedReceipt={selectedReceipt} onSelect={setSelectedReceipt} onRefresh={loadHistory} onNew={startNewOrder} />
        ) : receipt ? (
          <ReceiptView receipt={receipt} onNew={startNewOrder} onHistory={() => { setView('history'); loadHistory(); }} />
        ) : (
          <div className="workspace-grid">
            <section className="work-column">
              <div className="steps-strip">
                <div className={`step-chip ${!draft ? 'current' : 'done'}`}><span>{draft ? <Icon name="check" size={13} /> : '1'}</span> Record</div>
                <div className="step-line" />
                <div className={`step-chip ${draft ? 'current' : ''}`}><span>{orderReady ? <Icon name="check" size={13} /> : '2'}</span> Check order</div>
                <div className="step-line" />
                <div className={`step-chip ${readbackComplete ? 'current done' : ''}`}><span>{readbackComplete ? <Icon name="check" size={13} /> : '3'}</span> Confirm</div>
              </div>

              {!draft ? (
                <section className="card recording-card">
                  <div className="card-topline"><div><p className="eyebrow">NEW CUSTOMER ORDER</p><h2>What would they like?</h2><p className="muted">Speak naturally in Hindi or Hinglish. You can review the transcript before building the order.</p></div><span className="language-pill">हि · EN</span></div>
                  <div className={`record-zone ${isRecording ? 'recording' : busyProcessing ? 'processing' : ''}`}>
                    {isRecording ? <><div className="record-wave" aria-hidden="true"><i/><i/><i/><i/><i/><i/><i/></div><strong>Listening to the customer</strong><span>Recording stops after {recordSeconds}s</span><button className="stop-button" onClick={stopRecording}><span /> Stop & transcribe</button></> : busyProcessing ? <><span className="loader"/><strong>{recordState === 'requesting' ? 'Opening microphone…' : 'Transcribing with Gnani'}</strong><span>{recordState === 'processing' ? 'Converting to WAV, then sending securely' : 'Allow microphone access when prompted'}</span></> : <><button className="mic-button" onClick={() => beginRecording('order')} aria-label="Start recording an order"><Icon name="mic" size={31}/></button><strong>Tap to record</strong><span>Up to 25 seconds · Microphone audio is not saved</span></>}
                  </div>
                  {speechError && <div className={`alert ${recordState === 'processing' ? 'alert-info' : 'alert-error'}`} role="status">{speechError}</div>}
                  {transcript && <div className="transcript-block"><div className="section-heading"><div><span className="section-kicker">GNANI TRANSCRIPT</span><h3>Check what you heard</h3></div>{detectedLanguage && <span className="language-result">{detectedLanguage}</span>}</div><textarea value={transcript} onChange={(event) => setTranscript(event.target.value)} rows={3} aria-label="Editable speech transcript" placeholder="The actual transcript will appear here…"/><div className="transcript-actions"><span>Transcript is editable before parsing.</span><button className="primary-button" onClick={buildOrder}>Build order <Icon name="arrow" size={16}/></button></div></div>}
                  <div className="supported-note"><Icon name="spark" size={17}/><span><strong>Understands a focused catalogue</strong> Rice, atta, sugar, oil, milk, dal, salt, and biscuits. Say “aadha” or “dedh” for common fractions.</span></div>
                </section>
              ) : (
                <section className="card order-card">
                  <div className="card-topline order-card-head"><div><p className="eyebrow">ORDER IN PROGRESS</p><h2>Review every item</h2><p className="muted">Edit quantities, apply a correction, or remove a line before read-back.</p></div><button className="text-button" onClick={startNewOrder}>Start over</button></div>
                  <div className="transcript-summary"><span className="transcript-quote">“{transcript}”</span>{detectedLanguage && <span className="language-result">{detectedLanguage}</span>}</div>
                  <div className="table-scroll"><table className="order-table"><thead><tr><th>ITEM</th><th>QUANTITY</th><th>DEMO PRICE</th><th>AMOUNT</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
                    {liveItems.map((item, index) => <tr key={`${item.productId}-${index}`} className={incompleteItems.includes(item) ? 'incomplete-row' : ''}>
                      <td><div className="product-cell"><span className={`product-icon product-${item.productId}`}>{item.productId === 'oil' ? '◒' : item.productId === 'milk' ? '◐' : item.productId === 'biscuits' ? '▰' : item.productId === 'salt' ? '✦' : '◌'}</span><span>{item.manual ? <select value={item.productId} onChange={(event) => { const product = CATALOG.find((entry) => entry.id === event.target.value); updateLine(index, { productId: product.id, unit: product.baseUnit }); }} aria-label="Choose product">{CATALOG.filter((product) => product.id === item.productId || !draft.items.some((line, lineIndex) => lineIndex !== index && line.productId === product.id)).map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select> : <><strong>{item.product?.name}</strong><small>{item.product?.hindi}</small></>}</span></div></td>
                      <td><div className="quantity-edit"><input type="number" inputMode="decimal" min="0.001" max="10000" step="0.001" value={formatQuantity(item.quantityMilli)} onChange={(event) => updateLine(index, { quantityMilli: event.target.value === '' ? null : Math.round(Number(event.target.value) * 1000) })} aria-label={`Quantity for ${item.product?.name || 'product'}`} placeholder="Qty"/><select value={item.unit || ''} onChange={(event) => updateLine(index, { unit: event.target.value || null })} aria-label={`Unit for ${item.product?.name || 'product'}`}><option value="">Unit?</option>{item.product?.baseUnit && <option value={item.product.baseUnit}>{item.product.baseUnit}</option>}</select></div>{incompleteItems.includes(item) && <small className="field-hint">Add quantity and unit</small>}</td>
                      <td><span className="price-text">{item.product ? `${formatMoney(item.product.pricePerBasePaise)} / ${item.product.baseUnit}` : '—'}</span></td>
                      <td><strong className="amount-text">{item.lineTotalPaise ? formatMoney(item.lineTotalPaise) : '—'}</strong></td>
                      <td><button className="icon-button remove-button" onClick={() => removeLine(index)} aria-label={`Remove ${item.product?.name || 'item'}`}><Icon name="trash" size={17}/></button></td>
                    </tr>)}
                    {!liveItems.length && <tr><td className="empty-row" colSpan="5">No items yet. Add an item or apply a spoken correction.</td></tr>}
                  </tbody></table></div>
                  <button className="add-item-button" onClick={addManualItem} disabled={liveItems.length >= CATALOG.length}><Icon name="plus" size={17}/> Add catalogue item</button>
                  <div className="order-total"><div><span>Estimated total</span><small>Calculated from fixed demo prices</small></div><strong>{formatMoney(totalPaise)}</strong></div>

                  {activeIssues.length > 0 && <div className="clarification-panel"><div className="clarification-title"><span className="clarification-icon">?</span><div><strong>Needs your review</strong><small>Clarify missing details in the row, then mark each phrase reviewed.</small></div></div><div className="issue-list">{activeIssues.map((issue) => <div className="issue-row" key={issue.id}><span><strong>{issue.message}</strong><small>Heard: “{issue.text}”</small></span><button className="review-button" onClick={() => markIssueReviewed(issue.id)}>Mark reviewed</button></div>)}</div></div>}

                  <div className="correction-box"><div className="correction-icon"><Icon name="mic" size={18}/></div><div className="correction-content"><strong>Need to change something?</strong><p>“Chawal chaar kilo kar do” sets the amount. “Do kilo chawal aur jod do” adds more. Unclear instructions need review.</p>{speechError && !pendingCorrection && <div className={`alert ${recordState === 'processing' ? 'alert-info' : 'alert-error'}`} role="status">{speechError}</div>}{pendingCorrection ? <><label className="field-label" htmlFor="correction-text">Gnani heard</label><textarea id="correction-text" value={pendingCorrection} onChange={(event) => setPendingCorrection(event.target.value)} rows={2}/><div className="correction-actions"><button className="text-button" onClick={() => setPendingCorrection('')}>Discard</button><button className="secondary-button" onClick={applySpokenCorrection}>Apply correction</button></div></> : isRecording && recordPurpose === 'correction' ? <button className="stop-button" onClick={stopRecording}><span/>Stop correction · {recordSeconds}s</button> : <button className="secondary-button" onClick={() => beginRecording('correction')} disabled={busyProcessing}><Icon name="mic" size={16}/>{busyProcessing ? 'Transcribing correction…' : 'Record a correction'}</button>}</div></div>

                  <div className="confirmation-block">
                    <div className="confirmation-intro"><span className="confirm-check"><Icon name="check" size={17}/></span><span><strong>Read it back before saving</strong><small>Listen to the final order, then confirm to create a receipt.</small></span></div>
                    {readbackError && <div className="alert alert-error" role="alert">{readbackError}</div>}
                    {saveError && <div className="alert alert-error" role="alert">{saveError}</div>}
                    <div className="confirmation-actions"><button className="readback-button" disabled={!orderReady || readbackState === 'loading' || readbackState === 'playing'} onClick={requestReadback}><Icon name={readbackComplete ? 'check' : 'play'} size={17}/>{readbackState === 'loading' ? 'Preparing read-back…' : readbackState === 'playing' ? 'Playing order…' : readbackComplete ? 'Play order again' : 'Read order aloud'}</button><button className="confirm-button" disabled={!orderReady || !readbackComplete || !readbackToken || saving} onClick={confirmAndSave}><Icon name="check" size={18}/>{saving ? 'Saving…' : 'Confirm & save order'}</button></div>
                    <div className="confirmation-footnote">Saving requires a completed Gnani read-back and your confirmation.</div>
                  </div>
                </section>
              )}
            </section>

            <aside className="side-column">
              <div className="side-card today-card"><div className="side-card-header"><span className="side-icon"><Icon name="receipt" size={19}/></span><span className="tiny-label">TODAY AT THE COUNTER</span></div><strong className="stat-number">{history.length}</strong><span className="stat-caption">orders in history</span><button className="side-link" onClick={() => { setView('history'); loadHistory(); }}>See order history <Icon name="arrow" size={15}/></button></div>
              <div className="side-card guide-card"><div className="guide-heading"><span className="guide-icon"><Icon name="spark" size={17}/></span><div><span className="tiny-label">QUICK TIP</span><strong>Speak it your way</strong></div></div><p>Start with quantity and item. Corrections replace an earlier quantity.</p><div className="example-phrase"><span>“Do kilo chawal… Nahi, chawal teen kilo.”</span><span className="example-arrow">↓</span><strong>Rice · 3 kg</strong></div></div>
              <div className="side-card catalogue-card"><span className="tiny-label">SUPPORTED ITEMS</span><div className="catalogue-tags">{CATALOG.map((product) => <span key={product.id}>{product.hindi}</span>)}</div><div className="demo-price-note"><span>₹</span><p>All catalogue prices are fixed demo prices and may not match your shop.</p></div></div>
              <div className="privacy-note"><span className="privacy-dot"/><span>Order audio is processed for transcription and not stored. Confirmed order details are saved by the app server.</span></div>
            </aside>
          </div>
        )}
      </main>
      <footer className="footer"><span>BolBahi <span className="footer-dot">·</span> Made for the everyday kirana counter</span><span>Hinglish voice ordering <span className="footer-dot">·</span> Fixed demo prices</span></footer>
    </div>
  );
}

function HistoryView({ orders, loading, error, selectedReceipt, onSelect, onRefresh, onNew }) {
  if (selectedReceipt) return <ReceiptView receipt={selectedReceipt} onNew={onNew} onHistory={() => onSelect(null)} isHistory />;
  return <section className="card history-card"><div className="card-topline"><div><p className="eyebrow">ORDER HISTORY</p><h2>Recent orders</h2><p className="muted">Confirmed receipts stay in your order history. No audio is saved.</p></div><button className="text-button" onClick={onRefresh}>Refresh history</button></div>{error && <div className="alert alert-error">{error}</div>}{loading ? <div className="history-empty"><span className="loader"/>Loading saved orders…</div> : orders.length ? <div className="history-list">{orders.map((order) => <button className="history-row" key={order.id} onClick={() => onSelect(order)}><span className="history-receipt-icon"><Icon name="receipt" size={20}/></span><span className="history-main"><strong>{order.receiptNumber}</strong><small>{describeDate(order.createdAt)} <span>·</span> {order.items.length} {order.items.length === 1 ? 'item' : 'items'} <span>·</span> {order.customer}</small></span><strong className="history-total">{formatMoney(order.totalPaise)}</strong><span className="history-arrow"><Icon name="arrow" size={17}/></span></button>)}</div> : <div className="history-empty"><span className="empty-receipt"><Icon name="receipt" size={25}/></span><strong>No confirmed orders yet</strong><span>Once an order is read back and confirmed, its receipt will show here.</span><button className="primary-button" onClick={onNew}>Take your first order <Icon name="arrow" size={16}/></button></div>}</section>;
}

function ReceiptView({ receipt, onNew, onHistory, isHistory = false }) {
  if (!receipt) return null;
  return <section className="receipt-layout"><div className="receipt-success"><span className="success-mark"><Icon name="check" size={25}/></span><p className="eyebrow">CONFIRMED & SAVED</p><h2>{isHistory ? 'Saved receipt' : 'Order saved'}</h2><p>{isHistory ? 'This receipt is saved by the app server.' : 'Your customer’s order is ready at the counter.'}</p></div><div className="receipt-paper"><div className="receipt-paper-head"><div><span className="receipt-logo">ब</span><strong>BolBahi</strong></div><span className="demo-badge small">DEMO PRICES</span></div><div className="receipt-number"><span>RECEIPT</span><strong>{receipt.receiptNumber}</strong><small>{describeDate(receipt.createdAt)}</small></div><div className="receipt-customer"><span>Customer</span><strong>{receipt.customer}</strong><small>Synthetic walk-in identity</small></div><div className="receipt-lines"><div className="receipt-table-head"><span>ITEM</span><span>QTY</span><span>AMOUNT</span></div>{receipt.items.map((item) => <div className="receipt-line" key={item.productId}><span><strong>{item.name}</strong><small>{item.hindi}</small></span><span>{formatQuantity(item.quantityMilli)} {item.unit}</span><strong>{formatMoney(item.lineTotalPaise)}</strong></div>)}</div><div className="receipt-grand-total"><span>Order total</span><strong>{formatMoney(receipt.totalPaise)}</strong></div><div className="receipt-demo-note">Prices shown are fixed sample catalogue prices for this demo.</div><div className="receipt-thanks">Dhanyavaad <span>·</span> Thank you</div></div><div className="receipt-actions">{isHistory ? <button className="secondary-button" onClick={onHistory}>Back to history</button> : <button className="secondary-button" onClick={onHistory}>View order history <Icon name="receipt" size={16}/></button>}<button className="confirm-button" onClick={onNew}><Icon name="plus" size={17}/> New order</button></div></section>;
}

export default App;

