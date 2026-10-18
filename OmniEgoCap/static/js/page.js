// Nav border once the page is scrolled
const nav = document.querySelector(".nav");
const updateNav = () => nav.classList.toggle("is-scrolled", window.scrollY > 8);
updateNav();
window.addEventListener("scroll", updateNav, { passive: true });

// Light/dark button: without a saved choice the page follows the system (prefers-color-scheme)
const themeButton = document.querySelector("[data-theme-toggle]");
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const isDark = () => (document.documentElement.dataset.theme || (systemDark.matches ? "dark" : "light")) === "dark";
const labelTheme = () => {
  const dark = isDark();
  themeButton.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", dark ? "#111113" : "#ffffff"));
};
if (themeButton) {
  labelTheme();
  systemDark.addEventListener("change", labelTheme);
  themeButton.addEventListener("click", () => {
    const theme = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("theme", theme);
    } catch (e) {}
    labelTheme();
  });
}

// Play videos only while they are on screen
const visible = new IntersectionObserver(
  (entries) => {
    entries.forEach(({ target, isIntersecting }) => {
      if (isIntersecting) target.play().catch(() => {});
      else target.pause();
    });
  },
  { threshold: 0.4 }
);

// Video players: a clip switcher
document.querySelectorAll("[data-player]").forEach((player) => {
  const video = player.querySelector("video");
  const tabs = player.querySelectorAll(".tab");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      if (tab.classList.contains("is-active")) return;
      tabs.forEach((t) => {
        t.classList.toggle("is-active", t === tab);
        t.setAttribute("aria-pressed", t === tab);
      });
      video.poster = tab.dataset.poster;
      video.src = tab.dataset.src;
      video.play().catch(() => {});
    });
  });

  visible.observe(video);
});

const teaser = document.querySelector(".teaser video");
if (teaser) visible.observe(teaser);

// Copy BibTeX
const copyBtn = document.querySelector(".copy-btn");
if (copyBtn) {
  const label = copyBtn.querySelector("span");
  copyBtn.addEventListener("click", async () => {
    const code = document.getElementById("bibtex-code");
    try {
      await navigator.clipboard.writeText(code.textContent);
      label.textContent = "Copied";
    } catch {
      // No clipboard access (e.g. plain http): select the text instead
      window.getSelection().selectAllChildren(code);
      label.textContent = "Selected";
    }
    setTimeout(() => (label.textContent = "Copy"), 1800);
  });
}
