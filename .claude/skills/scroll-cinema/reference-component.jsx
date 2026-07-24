import { useEffect, useRef, useState } from 'react'
import { motion, useScroll, useTransform, useReducedMotion } from 'framer-motion'
import { Link } from 'react-router-dom'

// "What we do" as pinned scrollytelling. Three renderings by capability:
//
//  1. Desktop (fine pointer, wide): TRUE scroll-scrubbing — one continuous
//     24s frame-chained film (three acts joined by Kling end-frame-conditioned
//     camera travels; every joint starts on the previous segment's literal
//     last frame; encoded all-intra keyint=1 so any frame seeks instantly)
//     whose playhead is a rAF-lerped currentTime. The scrollbar IS the playhead.
//  2. Touch/small screens: pinned chapter crossfades of the individual loops
//     (currentTime scrubbing while native-scrolling is the known jank path on
//     Android — so phones get opacity-only transitions).
//  3. prefers-reduced-motion: a static stacked section, posters only.

const CHAPTERS = [
  {
    id: 'circulatio',
    numeral: 'I',
    latin: 'Circulatio',
    text: 'The whole plant, wildcrafted, is given over to the spirit — and the essence is drawn round in glass: the solvent rises, washes the herb, and returns, until the plant has given all it holds.',
    video: '/videos/gw2.mp4',
    poster: '/images/gw2-poster.jpg',
  },
  {
    id: 'calcinatio',
    numeral: 'II',
    latin: 'Calcinatio',
    text: 'The spent body goes to the fire — and what the fire leaves is not waste but essence. From our own laboratory: the ash, resting in glass.',
    video: '/videos/gwsalt.mp4',
    poster: '/images/gwsalt-poster.jpg',
  },
  {
    id: 'sal',
    numeral: 'III',
    latin: 'Sal',
    text: 'From the gray ash, the white salt — washed and crystallised: the mineral body of the plant, purified. Ours too, photographed on our own bench.',
    video: '/videos/gw4.mp4',
    poster: '/images/gw4-poster.jpg',
  },
  {
    id: 'opus',
    numeral: 'IV',
    latin: 'The Work, complete',
    text: 'The salt is returned to the tincture — body, soul and spirit reunited, sealed in amber glass for the collector\u2019s shelf.',
    video: '/videos/gw5.mp4',
    poster: '/images/gw5-poster.jpg',
    cta: true,
  },
]

const N = CHAPTERS.length

// Film timeline (must match the ffmpeg build of greatwork-scrub.mp4).
// Built from the owner's own apparatus: relit frames of the real footage
// (real geometry, invented light) — condenser->chamber descent 0-5s,
// chamber->real ash travel 5-10s, real ash 10-14s, travel 14-19s, bottle
// finale 19-25s. All joins frame-chained via Kling end-frame conditioning.
const FILM = { total: 34, src: '/videos/greatwork-scrub.mp4' }
const FILM_TEXT_SEC = [
  [0.3, 1.5, 7.0, 9.3],     // Circulatio: rides the descent, gone mid-travel
  [10.4, 11.6, 13.7, 15.5],  // Calcinatio: on the real ash act
  [19.4, 20.6, 22.7, 24.5],  // Sal: on the real salt crystals
  [28.6, 29.8, 33.0, 34.0],  // Opus: the bottle finale
]
const FILM_BOUNDS = [10 / 34, 19 / 34, 28 / 34]

const filmWindow = (i) => FILM_TEXT_SEC[i].map((t) => t / FILM.total)

const chapterWindow = (i) => {
  const ws = i / N
  const we = (i + 1) / N
  return [ws + 0.015, Math.min(ws + 0.09, we - 0.02), Math.max(we - 0.09, ws + 0.02), we - 0.015]
}

const Scrim = () => (
  <div
    aria-hidden="true"
    style={{
      position: 'absolute',
      inset: 0,
      background:
        'linear-gradient(90deg, rgba(10,9,8,0.82) 0%, rgba(10,9,8,0.45) 45%, rgba(10,9,8,0.18) 100%), linear-gradient(180deg, rgba(10,9,8,0.35) 0%, transparent 30%, transparent 70%, rgba(10,9,8,0.5) 100%)',
    }}
  />
)

const TextBlock = ({ chapter, index, progress, window: w }) => {
  const [inA, inB, outA, outB] = w
  const opacity = useTransform(
    progress,
    index === 0 ? [0, outA, outB] : index === N - 1 ? [inA, inB, 1] : [inA, inB, outA, outB],
    index === 0 ? [1, 1, 0] : index === N - 1 ? [0, 1, 1] : [0, 1, 1, 0],
  )
  const y = useTransform(progress, [inA, inB, outA, outB], index === 0 ? [0, 0, 0, -36] : [42, 0, 0, -36])
  return (
    <motion.div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: 'clamp(28px, 7vw, 110px)',
        maxWidth: 720,
        opacity,
        y,
      }}
    >
      <div className="alx-mono" style={{ color: 'var(--gold)', fontSize: 12, letterSpacing: '0.3em', marginBottom: 20 }}>
        {chapter.numeral} · {chapter.latin.toUpperCase()}
      </div>
      <h3
        className="alx-display alx-italic"
        style={{ fontStyle: 'italic', fontWeight: 400, fontSize: 'clamp(38px, 5.5vw, 72px)', lineHeight: 1.05, margin: '0 0 26px' }}
      >
        {chapter.latin}.
      </h3>
      <p style={{ fontSize: 'clamp(16px, 1.4vw, 19px)', lineHeight: 1.8, color: 'rgba(245,242,234,0.88)', margin: 0, maxWidth: 520 }}>
        {chapter.text}
      </p>
      {chapter.cta && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginTop: 40 }}>
          <a
            href="#apothecary"
            className="alx-btn primary"
            style={{ fontFamily: "'Cinzel', serif", fontSize: 12, fontWeight: 700, padding: '15px 28px' }}
          >
            Meet the Tinctures
          </a>
          <Link
            to="/blog/on-alchemical-salt"
            className="alx-mono"
            style={{ fontSize: 11, letterSpacing: '0.22em', color: 'var(--gold)', textTransform: 'uppercase' }}
          >
            The account of the salt →
          </Link>
        </div>
      )}
    </motion.div>
  )
}

const Rail = ({ active }) => (
  <div
    style={{
      position: 'absolute',
      right: 'clamp(20px, 3.5vw, 48px)',
      top: '50%',
      transform: 'translateY(-50%)',
      display: 'flex',
      flexDirection: 'column',
      gap: 22,
      zIndex: 2,
    }}
    aria-hidden="true"
  >
    {CHAPTERS.map((c, i) => (
      <span
        key={c.id}
        className="alx-mono"
        style={{
          fontSize: 11,
          letterSpacing: '0.18em',
          color: i === active ? 'var(--gold)' : 'rgba(245,242,234,0.3)',
          transition: 'color .5s var(--ease)',
          textAlign: 'right',
        }}
      >
        {c.numeral}
      </span>
    ))}
  </div>
)

const Eyebrow = () => (
  <div
    className="alx-eyebrow gold"
    style={{ position: 'absolute', top: 'clamp(24px, 4vw, 48px)', left: 'clamp(28px, 7vw, 110px)', zIndex: 2 }}
  >
    The Work — what we do
  </div>
)

/* ── Mode 2: chapter crossfades (touch) ─────────────────────────────── */

const ChapterVideo = ({ chapter, index, progress, videoRef, near }) => {
  const F = 0.045
  const start = index / N
  const end = (index + 1) / N
  const opacity = useTransform(
    progress,
    index === 0
      ? [0, end - F, end + F]
      : index === N - 1
        ? [start - F, start + F, 1]
        : [start - F, start + F, end - F, end + F],
    index === 0 ? [1, 1, 0] : index === N - 1 ? [0, 1, 1] : [0, 1, 1, 0],
  )
  return (
    <motion.div style={{ position: 'absolute', inset: 0, opacity }}>
      <video
        ref={videoRef}
        src={near ? chapter.video : undefined}
        poster={chapter.poster}
        muted
        loop
        playsInline
        preload={near ? (index === 0 ? 'auto' : 'metadata') : 'none'}
        aria-hidden="true"
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
      <Scrim />
    </motion.div>
  )
}

/* ── Static fallback (prefers-reduced-motion) ───────────────────────── */

const StaticWork = () => (
  <section style={{ background: '#000', borderBottom: '1px solid var(--rule)' }}>
    <div className="alx-inner" style={{ padding: 'clamp(72px, 9vw, 130px) var(--gutter)' }}>
      <div className="alx-eyebrow gold" style={{ marginBottom: 22 }}>The Work</div>
      <h2 className="alx-display" style={{ fontSize: 'clamp(34px, 4.6vw, 58px)', fontWeight: 400, margin: '0 0 48px' }}>
        What we do. <em className="alx-italic alx-gold" style={{ fontStyle: 'italic' }}>Solve et coagula.</em>
      </h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 32 }}>
        {CHAPTERS.map((c) => (
          <figure key={c.id} style={{ margin: 0 }}>
            <img src={c.poster} alt="" loading="lazy" style={{ width: '100%', height: 'auto', display: 'block', border: '1px solid var(--rule)' }} />
            <figcaption style={{ marginTop: 14 }}>
              <span className="alx-mono" style={{ color: 'var(--gold)', fontSize: 11, letterSpacing: '0.26em' }}>
                {c.numeral} · {c.latin.toUpperCase()}
              </span>
              <p className="alx-dim" style={{ fontSize: 15, lineHeight: 1.7, marginTop: 10 }}>{c.text}</p>
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  </section>
)

/* ── Main ───────────────────────────────────────────────────────────── */

const TheGreatWork = () => {
  const trackRef = useRef(null)
  const filmRef = useRef(null)
  const chapterVideoRefs = useRef(CHAPTERS.map(() => null))
  const progressRef = useRef(0)
  const smoothRef = useRef(0)
  const [active, setActive] = useState(0)
  // Video srcs attach only once the section approaches the viewport, so the
  // film never competes with the initial page load. Posters render meanwhile.
  const [near, setNear] = useState(false)
  const reduced = useReducedMotion()
  // Data-saver / very slow connections get the static poster layout.
  const [lite] = useState(() => {
    const c = typeof navigator !== 'undefined' && navigator.connection
    return Boolean(c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || '')))
  })
  // Scrub only where it works: precise pointers on wide screens.
  const [scrub] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(pointer: fine)').matches &&
      window.innerWidth >= 900,
  )

  const { scrollYProgress } = useScroll({ target: trackRef, offset: ['start start', 'end end'] })

  // Attach video sources when the section is within ~1.5 viewports.
  useEffect(() => {
    if (reduced || lite || near) return undefined
    const el = trackRef.current
    if (!el || typeof IntersectionObserver === 'undefined') { setNear(true); return undefined }
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) { setNear(true); io.disconnect() } },
      { rootMargin: '150% 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [reduced, lite, near])

  useEffect(() => {
    if (reduced) return undefined
    const unsub = scrollYProgress.on('change', (p) => {
      progressRef.current = p
      const idx = scrub
        ? FILM_BOUNDS.filter((b) => p >= b).length
        : Math.min(N - 1, Math.max(0, Math.floor(p * N)))
      setActive((prev) => (prev === idx ? prev : idx))
    })
    return unsub
  }, [scrollYProgress, reduced, scrub])

  // Scrub loop: ease the playhead toward the scroll target every frame.
  // The film is all-intra (keyint=1), so seeks land instantly on any frame.
  useEffect(() => {
    if (!scrub || reduced) return undefined
    let raf
    const tick = () => {
      const v = filmRef.current
      if (v && v.duration && !Number.isNaN(v.duration)) {
        const target = progressRef.current * (v.duration - 0.05)
        smoothRef.current += (target - smoothRef.current) * 0.14
        if (Math.abs(v.currentTime - smoothRef.current) > 0.02) {
          try { v.currentTime = smoothRef.current } catch { /* not seekable yet */ }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [scrub, reduced])

  // Touch mode: only the active chapter's loop plays.
  useEffect(() => {
    if (scrub || reduced || !near) return
    chapterVideoRefs.current.forEach((v, i) => {
      if (!v) return
      if (i === active) {
        const p = v.play()
        if (p?.catch) p.catch(() => {})
      } else if (!v.paused) {
        v.pause()
      }
    })
  }, [active, scrub, reduced, near])

  if (reduced || lite) return <StaticWork />

  return (
    <section
      ref={trackRef}
      style={{ position: 'relative', height: scrub ? '800vh' : `${N * 120}vh`, background: '#000' }}
      aria-label="What we do — the spagyric process"
    >
      <div style={{ position: 'sticky', top: 0, height: '100vh', overflow: 'hidden', borderBottom: '1px solid var(--rule)' }}>
        {scrub ? (
          <div style={{ position: 'absolute', inset: 0 }}>
            <video
              ref={filmRef}
              src={near ? FILM.src : undefined}
              poster={CHAPTERS[0].poster}
              muted
              playsInline
              preload={near ? 'auto' : 'none'}
              aria-hidden="true"
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
            <Scrim />
          </div>
        ) : (
          CHAPTERS.map((c, i) => (
            <ChapterVideo
              key={c.id}
              chapter={c}
              index={i}
              progress={scrollYProgress}
              near={near}
              videoRef={(el) => { chapterVideoRefs.current[i] = el }}
            />
          ))
        )}

        <Eyebrow />

        <div style={{ position: 'absolute', inset: 0, zIndex: 2 }}>
          {CHAPTERS.map((c, i) => (
            <TextBlock
              key={c.id}
              chapter={c}
              index={i}
              progress={scrollYProgress}
              window={scrub ? filmWindow(i) : chapterWindow(i)}
            />
          ))}
        </div>

        <Rail active={active} />
      </div>
    </section>
  )
}

export default TheGreatWork
