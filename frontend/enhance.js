// Motion on top of the pages, from two well-known open-source libraries:
//   anime.js 4.5.0 (MIT, github.com/juliangarnier/anime) - text, staggers, springs
//   vanilla-tilt.js 1.8.1 (MIT, github.com/micku7zu/vanilla-tilt.js) - cards that tilt under a mouse
// Both load on demand from jsDelivr. If they cannot load, or the visitor asks for less motion, nothing here
// runs and the pages look and work exactly the same.

const ANIME = "https://cdn.jsdelivr.net/npm/animejs@4.5.0/+esm";
const TILT = "https://cdn.jsdelivr.net/npm/vanilla-tilt@1.8.1/+esm";
const CALM = matchMedia("(prefers-reduced-motion: reduce)").matches;
const MOUSE = matchMedia("(hover: hover) and (pointer: fine)").matches;

let A = null;  // the anime.js module, once loaded

/** Once an entrance ends, hand the element back to the stylesheet so its own hover and press effects work. */
const tidy = (els) => () => [].concat(els).forEach((e) => { e.style.removeProperty("transform"); e.style.removeProperty("opacity"); });

/** Containers whose children rise in, one after another, the first time they are filled and on screen. */
// (lists that AutoAnimate already moves - #feed, #emList, #mostList, #queue, #list, .timeline, .mine - stay out)
const STAGGER = ".home-kpis, #catBars, #solved, #deptGrid, .steps3, .open-box, #kpis, .stage-track, .area-list, .stepper, .badges";
/** Cards that tilt towards the mouse on desktops. */
const TILTED = ".dept-card, a.feed-card, .ba, .step, .kpi, a.em-card, .open-box > div";

function riseIn(container) {
  const kids = [...container.children].filter((k) => !k.dataset.risen);
  if (!kids.length || !A) return;
  kids.forEach((k) => { k.dataset.risen = "1"; });
  A.animate(kids, {
    opacity: { from: 0 },
    translateY: { from: 22 },
    scale: { from: 0.97 },
    delay: A.stagger(55, { start: 40 }),
    duration: 650,
    ease: "outExpo",
    onComplete: tidy(kids),
  });
}

function watchStagger(root = document) {
  const seen = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { riseIn(e.target); e.target.dataset.inView = "1"; }
  }), { threshold: 0.08 });
  const hook = (c) => {
    if (c.dataset.staggerHooked) return;
    c.dataset.staggerHooked = "1";
    seen.observe(c);
    // re-rendered lists (a new town, a refresh) rise in again while on screen
    new MutationObserver(() => { if (c.dataset.inView) riseIn(c); }).observe(c, { childList: true });
  };
  root.querySelectorAll(STAGGER).forEach(hook);
  // containers that appear later (the officer dashboard after login, the tracking result)
  new MutationObserver(() => document.querySelectorAll(STAGGER).forEach(hook))
    .observe(document.body, { childList: true, subtree: true });
}

function heroIntro() {
  const h1 = document.querySelector(".hero h1");
  if (!h1 || !A?.splitText) return;
  // words, not letters: the gradient on the second line stays one piece per word
  const split = A.splitText(h1, { words: { wrap: "clip" } });
  A.animate(split.words, {
    translateY: { from: "100%" },
    opacity: { from: 0 },
    delay: A.stagger(70),
    duration: 900,
    ease: "outElastic(1, .7)",
  });
  const rest = [...document.querySelectorAll(".hero .kicker, .hero > p, .hero .cta-row > *, .hero .stats-row > *, .hero .live, .hero .demo")];
  A.animate(rest, { opacity: { from: 0 }, translateY: { from: 16 }, delay: A.stagger(80, { start: 250 }), duration: 700, ease: "outQuint", onComplete: tidy(rest) });
  const sun = document.querySelector(".chakra-bg");
  if (sun) A.animate(sun, { scale: [1, 1.06], opacity: [0.55, 0.7], duration: 3200, loop: true, alternate: true, ease: "inOutSine" });
}

async function tiltCards() {
  if (!MOUSE) return;
  let VanillaTilt;
  try { VanillaTilt = (await import(TILT)).default; } catch { return; }
  const apply = () => {
    const fresh = [...document.querySelectorAll(TILTED)].filter((el) => !el.vanillaTilt);
    if (fresh.length) VanillaTilt.init(fresh, { max: 6, speed: 500, scale: 1.02, glare: true, "max-glare": 0.12, perspective: 900 });
  };
  apply();
  new MutationObserver(apply).observe(document.body, { childList: true, subtree: true });
}

/** A springy entrance for one element, e.g. the ticket number. */
export function springIn(el, from = 0.4) {
  if (!A || !el) return;
  A.animate(el, { scale: { from }, rotate: { from: -6 }, duration: 1100, ease: A.spring ? A.spring({ bounce: 0.55 }) : "outElastic(1, .5)", onComplete: tidy(el) });
}

export async function enhance() {
  if (CALM) return;
  try { A = await import(ANIME); } catch { return; }
  document.documentElement.classList.add("js-anim");
  heroIntro();
  watchStagger();
  tiltCards();
}
