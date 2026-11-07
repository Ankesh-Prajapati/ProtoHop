// Voice-over synced to the animation. The player (patched in the bundle) calls
// window.__peEvent as each animation event starts and awaits window.__peGate after it, so every
// event is explained while it plays and the animation waits on it until the explanation ends.
// English uses pre-rendered neural-voice clips (assets/narration, built by tools/build_narration.py);
// other languages fall back to the browser's speech engine reading the translated step text.
(function () {
  const STORAGE_KEY = 'protocol-explorer:narrate'
  let enabled = true
  try { enabled = localStorage.getItem(STORAGE_KEY) !== 'off' } catch {}
  let cues = {}
  let timings = {}   // key -> [[sentenceStartSeconds, sentence], ...]
  const NARRATION_VERSION = '2' // bump after re-rendering clips so browsers fetch the new audio
  fetch('assets/narration/timings.json?v=' + NARRATION_VERSION).then(r => r.json()).then(t => { timings = t }).catch(() => {})
  fetch('assets/narration/cues.json?v=' + NARRATION_VERSION).then(r => r.json()).then(c => { cues = c; if (enabled) onScreenChange(true) }).catch(() => {})
  // Browsers block sound until the visitor has interacted with the page.
  const mayPlay = () => !navigator.userActivation || navigator.userActivation.hasBeenActive

  let current = null   // { key, text, kind: 'event' | 'overview' | 'done' }
  let busy = false
  let pending = null
  let gates = []
  let token = 0
  let lastScreenKey = ''
  const audio = new Audio()
  audio.preload = 'auto'

  const $ = sel => document.querySelector(sel)
  const txt = (root, sel) => (root?.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim()
  const sentence = s => (s && !/[.!?…)]$/.test(s) ? s + '.' : s)
  const isEnglish = () => (document.documentElement.lang || 'en').toLowerCase().startsWith('en')
  const lessonPlaying = () => !!$('.toggle')?.classList.contains('is-playing')
  const ttsPaused = () => 'speechSynthesis' in window && speechSynthesis.paused
  const isPaused = () => (current?.audio ? audio.paused : ttsPaused())

  // ---------- highlighting ----------
  const HL = 'pe-hl'
  // The explained part stays at full strength while the rest of the diagram steps back.
  function clearHighlight() {
    for (const el of document.querySelectorAll(`.${HL}, .pe-hl-row`)) el.classList.remove(HL, 'pe-hl-row')
    $('.network')?.classList.remove('pe-focus')
  }
  // Nodes a packet passes through, read from the diagram's links (data-lane="a>b").
  function route(net, from, to) {
    const links = {}
    for (const lane of net.querySelectorAll('.lane[data-lane]')) {
      const [a, b] = lane.dataset.lane.split('>')
      ;(links[a] ||= new Set()).add(b)
      ;(links[b] ||= new Set()).add(a)
    }
    const prev = { [from]: null }
    const queue = [from]
    while (queue.length && !(to in prev)) {
      const at = queue.shift()
      for (const next of links[at] || []) if (!(next in prev)) { prev[next] = at; queue.push(next) }
    }
    if (!(to in prev)) return [from, to]
    const path = []
    for (let at = to; at != null; at = prev[at]) path.push(at)
    return path
  }

  function highlightEvent(ev) {
    clearHighlight()
    const net = $('.network')
    if (!net) return
    // a device appearing: keep the whole scene visible while it builds up
    if (ev.type === 'show') return
    const node = id => net.querySelector(`g.node[data-node="${id}"]`)
    let ids = []
    if (ev.type === 'packet' || ev.type === 'stream') ids = route(net, ev.from, ev.to)
    else if (ev.type === 'type-url') ids = ['client']
    else if (ev.type === 'note' || ev.type === 'label') ids = [ev.at]
    else ids = [ev.frame || 'client']
    ids.map(node).forEach(el => el && el.classList.add(HL))
    net.classList.add('pe-focus')
  }
  function highlightLatestRow() {
    const rows = [...document.querySelectorAll('tr[data-packet]')].filter(r => !r.hidden && r.dataset.shown === '1')
    rows.at(-1)?.classList.add('pe-hl-row')
  }

  // ---------- caption ----------
  const caption = document.createElement('div')
  caption.id = 'pe-caption'
  caption.setAttribute('aria-live', 'polite')
  caption.hidden = true
  function showCaption(text) {
    const sim = $('.simulation')
    if (sim && caption.parentNode !== sim) sim.appendChild(caption)
    caption.textContent = text
    caption.hidden = !text
    updateCaptionSpace()
  }

  // Keep captions in a reserved strip so they cannot cover diagram nodes. The strip stays while voice
  // is on and only ever grows: resizing it per caption would make the diagram jump between sentences.
  const CAPTION_SPACE = 66 // two lines of caption
  let captionSpace = CAPTION_SPACE
  function updateCaptionSpace() {
    const sim = $('.simulation')
    if (!sim) return
    sim.classList.toggle('has-caption', enabled)
    if (!enabled) return sim.style.removeProperty('--caption-space')
    if (!caption.hidden) captionSpace = Math.max(captionSpace, Math.ceil(caption.offsetHeight + 16))
    sim.style.setProperty('--caption-space', `${captionSpace}px`)
  }
  new ResizeObserver(updateCaptionSpace).observe(caption)
  window.addEventListener('resize', () => { captionSpace = CAPTION_SPACE; updateCaptionSpace() })
  // Only the sentence being spoken is shown.
  let lines = []
  const sentences = text => text.split(/(?<=[.!?…])\s+/).filter(Boolean)
  audio.addEventListener('timeupdate', () => {
    if (!busy || !current?.audio || !lines.length) return
    let line = lines[0][1]
    for (const [at, text] of lines) if (at <= audio.currentTime + 0.05) line = text
    if (caption.textContent !== line) showCaption(line)
  })

  // ---------- playback ----------
  window.__peGate = () => {
    if (!enabled) return undefined
    highlightLatestRow()
    return busy && current?.kind === 'event' ? new Promise(res => gates.push(res)) : undefined
  }
  function openGates() { const g = gates; gates = []; g.forEach(res => res()) }

  let voice = null
  const PREFERRED = [/natural/i, /online/i, /neural/i, /google/i, /premium/i, /enhanced/i]
  function pickVoice() {
    if (!('speechSynthesis' in window)) return null
    const lang = (document.documentElement.lang || 'en').toLowerCase()
    const voices = speechSynthesis.getVoices().filter(v => v.lang.toLowerCase().startsWith(lang.split('-')[0]))
    for (const re of PREFERRED) { const v = voices.find(v => re.test(v.name)); if (v) return v }
    return voices.find(v => v.lang.toLowerCase() === lang) || voices[0] || null
  }
  if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', () => { voice = pickVoice() })

  function stop() {
    token++
    busy = false
    audio.pause()
    if ('speechSynthesis' in window) speechSynthesis.cancel()
  }

  function finished(id) {
    if (id !== token) return
    busy = false
    if (pending) { const p = pending; pending = null; return start(p) }
    showCaption('')
    openGates()
    render()
  }

  function speakText(text, id) {
    if (current) current.audio = false
    if (!('speechSynthesis' in window) || !text) return finished(id)
    voice = voice || pickVoice()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = document.documentElement.lang || 'en'
    if (voice) u.voice = voice
    u.rate = 0.95
    const parts = sentences(text)
    let at = 0
    const starts = parts.map(p => { const s = at; at += p.length + 1; return s })
    showCaption(parts[0] || '')
    u.onboundary = e => {
      let i = 0
      while (i + 1 < starts.length && starts[i + 1] <= e.charIndex) i++
      if (caption.textContent !== parts[i]) showCaption(parts[i])
    }
    u.onend = u.onerror = () => finished(id)
    speechSynthesis.speak(u)
  }

  // text: string, or a function producing it (non-English steps read the panel once it has updated)
  function start(c, delay = 0) {
    stop()
    pending = null
    openGates()
    current = c
    busy = true
    if (c.kind !== 'event') clearHighlight()
    const id = token
    render()
    setTimeout(render, 500) // the step label in the panel updates after its transition
    const go = () => {
      if (id !== token) return
      const text = typeof c.text === 'function' ? c.text() : c.text
      if (isEnglish() && cues[c.key]) {
        c.audio = true
        lines = timings[c.key] || [[0, text]]
        showCaption(lines[0][1])
        audio.onended = () => finished(id)
        audio.onerror = () => { if (id === token) speakText(text, id) }
        audio.src = `assets/narration/${c.key}.mp3?v=${NARRATION_VERSION}`
        audio.play().catch(err => {
          if (id !== token) return
          err.name === 'NotAllowedError' ? finished(id) : speakText(text, id)
        })
      } else {
        speakText(text, id)
      }
    }
    delay ? setTimeout(go, delay) : go()
  }

  function stepText() {
    const step = $('.overview-stage [data-view="step"]')
    return ['.explain-title', '.explain-sub', '.explain-text'].map(s => sentence(txt(step, s))).filter(Boolean).join(' ')
  }

  window.__peEvent = (lesson, stepIndex, eventIndex, ev) => {
    if (!enabled || ev.type === 'focus') return
    highlightEvent(ev)
    lastScreenKey = ''
    const key = `${lesson}-${stepIndex + 1}-${eventIndex}`
    if (isEnglish() && cues[key]) return start({ key, text: cues[key], kind: 'event' })
    if (!isEnglish() && eventIndex === 0) start({ key, text: stepText, kind: 'event' }, 450)
  }

  function screen() {
    const stage = $('.overview-stage')
    const lesson = $('#protocols')?.dataset.lesson
    if (!stage || !lesson) return null
    const step = stage.querySelector('[data-view="step"]')
    if (step && !step.hidden) {
      // the panel's is-done can linger from the previous lesson; the play button reflects this one
      if (!step.classList.contains('is-done') || !$('.toggle')?.classList.contains('is-done')) return null
      const key = `${lesson}-done`
      return { key, kind: 'done', text: isEnglish() && cues[key] ? cues[key] : stepText() }
    }
    const ov = stage.querySelector('[data-view="overview"]')
    const key = `${lesson}-0`
    const own = ['h3', '.overview-full', '.overview-desc'].map(s => sentence(txt(ov, s))).filter(Boolean).join(' ')
    return { key, kind: 'overview', text: isEnglish() && cues[key] ? cues[key] : own }
  }

  function onScreenChange(force) {
    if (!enabled || !mayPlay()) return
    const c = screen()
    if (!c || (!force && c.key === lastScreenKey)) return
    if (c.kind === 'overview' && lessonPlaying()) return
    lastScreenKey = c.key
    if (c.kind === 'done') {
      if (busy && current?.kind === 'event') { pending = c; return }
      clearHighlight()
    }
    if (c.kind === 'overview') clearHighlight()
    start(c)
  }

  // Pausing or resuming the lesson pauses or resumes the voice with it.
  function syncWithLesson() {
    if (!enabled || !busy || current?.kind !== 'event') return
    if (lessonPlaying()) {
      if (isPaused()) current.audio ? audio.play().catch(() => {}) : speechSynthesis.resume()
    } else if (!isPaused()) {
      current.audio ? audio.pause() : speechSynthesis.pause()
    }
    render()
  }
  document.addEventListener('click', e => { if (e.isTrusted && e.target.closest?.('.toggle')) setTimeout(syncWithLesson, 50) }, true)
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && !e.target.closest?.('input, textarea, select, button, [contenteditable="true"]')) setTimeout(syncWithLesson, 50)
  }, true)
  audio.addEventListener('playing', () => render())
  audio.addEventListener('pause', () => render())

  // ---------- UI ----------
  const style = document.createElement('style')
  style.textContent = `
    .nf-voice { gap: 7px; min-width: 0; padding: 0 11px 0 9px; }
    .nf-voice svg { flex: none; }
    .nf-voice[aria-pressed="true"] { color: var(--nf-accent-text); border-color: color-mix(in srgb, var(--nf-accent) 45%, var(--line)); }
    .nf-voice.is-speaking { background: var(--nf-accent-tint); }
    .nf-voice.is-floating { position: fixed; right: 16px; bottom: 16px; z-index: 50; background: var(--panel); }
    /* phones and narrow screens dock the controls in a fixed grid: give VOICE its own icon-only column */
    .is-single .packet-actions { grid-template-columns: 42px 46px 42px minmax(84px, 240px) 60px 42px; }
    .is-single .nf-voice { padding: 0; gap: 0; justify-content: center; }
    .is-single .nf-voice span { display: none; }
    /* medium layout: icon-only like the app's RESET button, so the colour key keeps its room */
    :root[data-layout="medium"] .nf-voice { min-width: 34px; width: 34px; padding: 0; gap: 0; justify-content: center; }
    :root[data-layout="medium"] .nf-voice span { display: none; }

    /* filter, not opacity: the app drives node visibility through inline opacity */
    .network g.node { transition: filter .3s; }
    .network.pe-focus g.node:not(.pe-hl) { filter: opacity(.3) saturate(.4); }
    tr.pe-hl-row > td { background: var(--nf-accent-tint) !important; color: var(--ink) !important; }
    tr.pe-hl-row > td:first-child { box-shadow: inset 2px 0 0 var(--nf-accent) !important; }

    /* overflow: the grid is drawn inside the SVG; let it run behind the caption strip, clipped by the panel */
    .simulation.has-caption .network { bottom: auto; height: calc(100% - var(--caption-space, 64px)); overflow: visible; }
    #pe-caption { position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%); z-index: 5;
      width: max-content; max-width: min(calc(100% - 24px), 600px); padding: 6px 12px; border-radius: 6px;
      background: var(--panel); color: var(--ink); border: 1px solid var(--line);
      font: 500 12.5px/1.45 var(--nf-sans, system-ui, sans-serif); text-align: center; text-wrap: balance;
      pointer-events: none; }`
  document.head.appendChild(style)

  const ICON = {
    on: '<path d="M3 6h2.5L9 3v10L5.5 10H3z"/><path d="M11.5 5.5a3.5 3.5 0 0 1 0 5M13.5 3.5a6.3 6.3 0 0 1 0 9" fill="none"/>',
    off: '<path d="M3 6h2.5L9 3v10L5.5 10H3z"/><path d="m11.5 6 3.5 4m0-4-3.5 4" fill="none"/>',
    pause: '<path d="M5 3.5v9M11 3.5v9" fill="none" stroke-width="2.2"/>'
  }
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.id = 'narrator-toggle'
  btn.className = 'btn nf-voice'
  function render() {
    const paused = enabled && busy && isPaused() && current?.audio !== undefined
    const what = current?.kind === 'overview' ? 'the overview' : current?.kind === 'done' ? 'the recap' : txt(document, '.explain-label').toLowerCase() || 'this step'
    const icon = !enabled ? ICON.off : paused ? ICON.pause : ICON.on
    btn.innerHTML = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg><span>VOICE</span>`
    btn.classList.toggle('is-speaking', enabled && busy && !paused)
    btn.title = !enabled ? 'Voice explanations are off. Click to turn them on.'
      : busy ? `${paused ? 'Paused' : 'Explaining'} ${what}. Click to turn voice off.`
      : 'Voice explanations are on. Click to turn them off.'
    btn.setAttribute('aria-label', btn.title)
    btn.setAttribute('aria-pressed', String(enabled))
  }
  render()

  let debounceId = null
  const onChange = () => { clearTimeout(debounceId); debounceId = setTimeout(() => onScreenChange(false), 150) }
  const observer = new MutationObserver(onChange)
  function attach() {
    const stage = $('.overview-stage')
    const list = $('#protocols')
    const toggle = $('.toggle')
    if (!stage || !list || !toggle) return false
    for (const panel of stage.querySelectorAll('.overview-body')) observer.observe(panel, { attributes: true, attributeFilter: ['hidden', 'class'] })
    observer.observe(toggle, { attributes: true, attributeFilter: ['class'] })
    observer.observe(list, { attributes: true, attributeFilter: ['data-lesson'] })
    updateCaptionSpace()
    return true
  }
  if (!attach()) {
    const appWatcher = new MutationObserver(() => { if (attach()) appWatcher.disconnect() })
    appWatcher.observe(document.body, { childList: true, subtree: true })
  }

  new MutationObserver(() => { voice = pickVoice(); if (busy && current?.kind !== 'event') onScreenChange(true) })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })

  btn.addEventListener('click', () => {
    enabled = !enabled
    try { localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off') } catch {}
    if (enabled) {
      onScreenChange(true)
    } else {
      stop()
      pending = null
      showCaption('')
      clearHighlight()
      openGates()
    }
    updateCaptionSpace()
    render()
  })

  // Sits in the packet-flow toolbar beside PLAY; floats only if that toolbar is missing.
  function placeButton() {
    const bar = $('.packet-actions')
    if (!bar) return false
    btn.classList.remove('is-floating')
    bar.prepend(btn)
    return true
  }
  if (!placeButton()) {
    btn.classList.add('is-floating')
    document.body.appendChild(btn)
    const w = new MutationObserver(() => { if (placeButton()) w.disconnect() })
    w.observe(document.body, { childList: true, subtree: true })
  }
})()
