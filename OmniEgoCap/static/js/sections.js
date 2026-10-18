// Body sections added on top of page.js: the videos of #why and #omniegodb (files in static/oec/).
//
// - video[data-autoplay] plays while at least 40 % of it is on screen and pauses when it leaves. The videos carry
//   preload="none", so nothing is downloaded before a video first comes on screen.
// - prefers-reduced-motion: nothing plays by itself; every video gets its controls instead.
// - ② (#why-fov): one device toggle swaps the video file (why_devices_<track>.mp4); until a button is clicked the
//   four devices and then the all-devices overlay take turns, half a loop (4 s) each, cross-fading.
// - [data-oec-player] (#omniegodb): thumbnail tabs swap the video file, the per-tab caption and the
//   legend (no UniEgoMotion key when data-lanes="3").
// Swapping always pauses the old video first; the new one starts only if the slot is on screen and motion is allowed.
(() => {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const videos = [...document.querySelectorAll("video[data-autoplay]")];
  const onScreen = new Set();

  const mayPlay = (v) => !reduce.matches && onScreen.has(v);
  const play = (v) => {
    if (mayPlay(v)) v.play().catch(() => {});
  };

  // players that ship with controls keep them; the others get controls only under reduced motion
  const shipsControls = new Set(videos.filter((v) => v.hasAttribute("controls")));
  function applyMotion() {
    videos.forEach((v) => {
      v.controls = reduce.matches || shipsControls.has(v);
      if (reduce.matches) v.pause();
      else play(v);
    });
  }
  applyMotion();
  reduce.addEventListener?.("change", applyMotion);

  const io = new IntersectionObserver(
    (entries) =>
      entries.forEach(({ target, isIntersecting }) => {
        if (isIntersecting) {
          onScreen.add(target);
          play(target);
        } else {
          onScreen.delete(target);
          target.pause();
        }
      }),
    { threshold: 0.4 }
  );
  videos.forEach((v) => io.observe(v));

  // swap the file of a video in place: stop the old one, then start the new one when allowed
  function swap(v, src, poster, label) {
    v.pause();
    if (poster) v.poster = poster;
    v.src = src;
    if (label) v.setAttribute("aria-label", label);
    play(v);
  }

  // ② one device toggle for the main video
  const scene = document.querySelector("[data-fov-scene]");
  if (scene) {
    const buttons = [...scene.querySelectorAll(".fov-devices button")];
    const slot = scene.querySelector(".fov-video");
    const video = slot.querySelector("video");
    const fill = (pattern, t) => pattern.replaceAll("{track}", t);
    const select = (b) => {
      if (b.getAttribute("aria-pressed") === "true") return;
      buttons.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      const t = b.dataset.track;
      swap(
        video,
        fill(slot.dataset.video, t),
        fill(slot.dataset.poster, t),
        t === "all"
          ? "All four devices' regions on one sphere around the wearer's head"
          : `${b.textContent.trim()} on the wearer's head and the region it covers, drawn on a sphere`
      );
    };
    buttons.forEach((b) => {
      if (b.dataset.track !== "all") b.style.setProperty("--key", `var(--fov-${b.dataset.track.replace("_", "-")})`);
      b.addEventListener("click", () => {
        stopCycle();
        select(b);
      });
    });

    // Auto tour Aria (Stereo) -> Aria (RGB) -> GoPro -> Quest -> All -> ... (author 10/18: the overlay too) while
    // nobody has clicked a button: every
    // device video has the same camera path and length (8 s loop), so at the end of one loop the next device's
    // video starts at frame 0 underneath and the two cross-fade. A click on any button ends the tour (that video
    // then loops as before). Not under reduced motion (nothing plays by itself there).
    const tour = buttons;
    const label = (b) =>
      b.dataset.track === "all"
        ? "All four devices' regions on one sphere around the wearer's head"
        : `${b.textContent.trim()} on the wearer's head and the region it covers, drawn on a sphere`;
    const back = video.cloneNode(false);
    back.removeAttribute("data-autoplay");
    back.removeAttribute("src");
    back.removeAttribute("poster");
    back.preload = "auto";
    back.classList.add("fov-back");
    back.setAttribute("aria-hidden", "true");
    slot.append(back);
    let front = video, cycling = !reduce.matches, slotSeen = false;
    const at = () => tour.findIndex((x) => x.getAttribute("aria-pressed") === "true");
    const prepare = () => {
      const nb = tour[(at() + 1) % tour.length];
      const other = front === video ? back : video;
      const src = fill(slot.dataset.video, nb.dataset.track);
      if (!other.src.endsWith(src)) {
        other.src = src;
        other.load();
      }
      return nb;
    };
    const advance = () => {
      if (!cycling || at() < 0) return;
      const nb = prepare();
      const other = front === video ? back : video;
      other.currentTime = 0;
      other.play().catch(() => {});
      other.classList.remove("is-hidden");
      front.classList.add("is-hidden");
      const old = front;
      setTimeout(() => old.pause(), 400);
      front = other;
      buttons.forEach((x) => x.setAttribute("aria-pressed", String(x === nb)));
      front.setAttribute("aria-label", label(nb));
      setTimeout(prepare, 1500); // fetch the one after while this one plays
    };
    function stopCycle() {
      if (!cycling) return;
      cycling = false;
      if (front !== video) {
        // hand the visible state back to the main element so the click handler and the observer keep working
        video.src = front.src;
        video.currentTime = front.currentTime;
        video.classList.remove("is-hidden");
        front.pause();
        front.classList.add("is-hidden");
        front = video;
        play(video);
      }
      video.loop = true;
    }
    if (cycling) {
      video.loop = back.loop = false;
      back.classList.add("is-hidden");
      // author 10/18: the tour shows half of each 8 s loop (the camera's half turn ends where it started, so the
      // next device starts from the same view); a whole round of the five takes about 20 s
      const HALF = 4.0;
      [video, back].forEach((v) =>
        v.addEventListener("timeupdate", () => v === front && cycling && v.currentTime >= HALF - 0.1 && advance())
      );
      [video, back].forEach((v) => v.addEventListener("ended", () => v === front && advance()));
      new IntersectionObserver(([e]) => {
        slotSeen = e.isIntersecting;
        if (!slotSeen) [video, back].forEach((v) => v.pause());
        else if (cycling && front !== video) front.play().catch(() => {});
        if (slotSeen && cycling) {
          prepare();
          // the page-wide observer may restart the hidden element too; keep only the visible one playing
          setTimeout(() => [video, back].forEach((v) => v !== front && v.pause()), 50);
        }
      }, { threshold: 0.4 }).observe(slot);
      reduce.addEventListener?.("change", () => reduce.matches && stopCycle());
    }
  }

  // thumbnail-tab players
  document.querySelectorAll("[data-oec-player]").forEach((player) => {
    const video = player.querySelector("video");
    const tabs = [...player.querySelectorAll(".oec-tab")];
    const caption = player.querySelector("[data-oec-caption]");
    const uemKey = player.querySelector("[data-uem]");
    const legendFor = (tab) => {
      if (uemKey) uemKey.hidden = tab.dataset.lanes === "3";
      if (caption && tab.dataset.caption) caption.textContent = tab.dataset.caption;
    };
    tabs.forEach((tab) =>
      tab.addEventListener("click", () => {
        if (tab.classList.contains("is-active")) return;
        tabs.forEach((t) => {
          t.classList.toggle("is-active", t === tab);
          t.setAttribute("aria-pressed", String(t === tab));
        });
        legendFor(tab);
        swap(video, tab.dataset.src, tab.dataset.poster);
      })
    );
    const first = tabs.find((t) => t.classList.contains("is-active")) || tabs[0];
    if (first) legendFor(first);
  });
})();
