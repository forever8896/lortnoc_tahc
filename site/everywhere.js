// /everywhere, /everywhere/world, /everywhere/ens: reveal on scroll and a copy button on every
// command block. The landing's films and thread keep their own script (from site/v2.html).
document.documentElement.classList.add('js')

const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add('is-in'), io.unobserve(e.target))), { rootMargin: '0px 0px -12% 0px' })
document.querySelectorAll('[data-reveal]').forEach((el) => io.observe(el))

const COPY = document.getElementById('i-copy')?.innerHTML ?? ''
const CHECK = document.getElementById('i-check')?.innerHTML ?? ''
document.querySelectorAll('pre').forEach((pre) => {
  const box = document.createElement('div')
  box.className = 'code'
  pre.replaceWith(box)
  box.append(pre)
  const b = document.createElement('button')
  Object.assign(b, { className: 'copy', type: 'button', title: 'Copy', innerHTML: COPY })
  b.setAttribute('aria-label', 'Copy')
  b.onclick = async () => {
    // copy the commands, not the comments
    await navigator.clipboard.writeText(pre.innerText.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n').trim())
    b.innerHTML = CHECK
    b.classList.add('done')
    setTimeout(() => ((b.innerHTML = COPY), b.classList.remove('done')), 1600)
  }
  box.append(b)
})
