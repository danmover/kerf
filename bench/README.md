# Timing the app on a real graphics card

How long Kerf takes on a given computer differs most in the 3D view: a shader that one graphics card builds in
20 ms takes another several seconds, and a headless test in the cloud has no graphics card at all. `measure.cjs`
runs a production build of the app in a real browser window on the computer in front of you and writes down:

- how long a design takes to open and check from cold, and after a one-part edit, the same edit undone, and an
  edit that rebuilds 14 parts
- frame times while the view is turned, with and without a section, and while an edit's checks run
- every stop of the page of 100 ms or more, by what the app was doing (the app's own freeze record, `src/app/stalls.ts`)
- every call into the graphics card that waited 8 ms or more (shader builds, read-backs)

The robot dog (`designs/robot-dog.kerf`, 560 solids) is the design the v2 plan's targets are set on: its full
checks in 6 s or less from cold and in 0.3 s or less after a one-part edit.

## Use

A production build has no way in from outside, so the build that is measured gets a handle first. Do this in a
throwaway checkout or worktree, never one with work in it:

```
node bench/hook.cjs .                     # appends a few lines to src/main.tsx (git checkout src/main.tsx undoes it)
npx vite build
npx vite preview --port 5302 --strictPort
```

Then, from any folder where `playwright-core` (or `playwright`) can be required:

```
node bench/measure.cjs http://localhost:5302/ bench/designs/robot-dog.kerf out.json new
```

On Windows it drives the installed Microsoft Edge in a window (Direct3D through ANGLE, as the desktop app does);
elsewhere a bundled Chromium with software graphics, or none with `NOGL=1`. Leave the window alone while it runs.

Every run starts with an empty browser profile, so every shader is built from nothing, as on the first start
after an update. With `PROFILE=<folder>` the browser keeps its files in that folder: run twice, and the second
run has the shaders the first one built.

To compare two versions, build each in its own worktree on its own port and run them turn about.
