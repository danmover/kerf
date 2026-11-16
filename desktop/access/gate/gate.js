// The sign-in window's page. It only shows forms and passes what's typed to
// the main process (window.kerfGate, desktop/access/gate-preload.ts), which
// decides everything.
"use strict";

(function () {
  const gate = window.kerfGate;
  const $ = (id) => document.getElementById(id);
  const views = ["loading", "signin", "owner", "noserver"];
  let screen = null;

  function show(id) {
    for (const v of views) $(v).hidden = v !== id;
    const first = { signin: screen && screen.last ? "si-password" : "si-user", owner: "ow-user" }[id];
    if (first) setTimeout(() => $(first).focus(), 30);
  }

  function error(prefix, message, field) {
    const el = $(prefix + "-error");
    el.textContent = message || "";
    el.hidden = !message;
    for (const f of ["user", "password"]) $(prefix + "-" + f).classList.toggle("bad", !!message && field === f);
  }

  function busy(button, on) {
    $(button).disabled = on;
    $(button).classList.toggle("busy", on);
  }

  for (const b of document.querySelectorAll(".peek")) {
    b.addEventListener("click", () => {
      const input = $(b.dataset.for);
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      b.textContent = showing ? "Show" : "Hide";
      b.setAttribute("aria-label", showing ? "Show password" : "Hide password");
      input.focus();
    });
  }

  $("signin").addEventListener("submit", async (e) => {
    e.preventDefault();
    const user = $("si-user").value.trim();
    const password = $("si-password").value;
    if (!user) return error("si", "Type your username.", "user");
    if (!password) return error("si", "Type your password.", "password");
    error("si", "");
    busy("si-go", true);
    try {
      const r = await gate.signIn(user, password, $("si-stay").checked);
      if (!r.ok) {
        error("si", r.message, r.field);
        if (r.field === "password") $("si-password").select();
      }
    } catch (err) {
      error("si", "Something went wrong signing in: " + (err && err.message ? err.message : err));
    } finally {
      busy("si-go", false);
    }
  });

  $("owner").addEventListener("submit", async (e) => {
    e.preventDefault();
    const user = $("ow-user").value.trim().toLowerCase();
    const password = $("ow-password").value;
    if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(user)) return error("ow", "Usernames are 2 to 32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit.", "user");
    if (password.length < 8) return error("ow", "Use at least 8 characters for the password.", "password");
    if (password !== $("ow-again").value) return error("ow", "The two passwords don't match.", "password");
    error("ow", "");
    busy("ow-go", true);
    try {
      const r = await gate.setUpOwner(user, password, $("ow-stay").checked);
      if (!r.ok) error("ow", r.message, r.field);
    } catch (err) {
      error("ow", "Something went wrong: " + (err && err.message ? err.message : err));
    } finally {
      busy("ow-go", false);
    }
  });

  $("to-owner").addEventListener("click", () => show("owner"));
  $("to-signin").addEventListener("click", () => show("signin"));
  $("quit").addEventListener("click", () => gate.quit());

  $("copy").addEventListener("click", async () => {
    await gate.copyCode();
    $("copy").textContent = "Copied";
    setTimeout(() => ($("copy").textContent = "Copy"), 1600);
  });

  async function load() {
    show("loading");
    screen = await gate.screen();
    $("code").textContent = screen.computer;
    $("version").textContent = "Kerf " + screen.version;
    if (!screen.server) return show("noserver");
    if (screen.last) $("si-user").value = screen.last;
    $("si-stay").checked = !!screen.stay;
    if (screen.notice) error("si", screen.notice);
    $("to-owner").hidden = !screen.ownerSetup;
    show(screen.ownerSetup && !screen.accounts.length ? "owner" : "signin");
  }

  load().catch((err) => {
    show("signin");
    error("si", "Kerf couldn't start its sign-in: " + (err && err.message ? err.message : err));
  });
})();
