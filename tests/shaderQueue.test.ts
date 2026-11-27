// Shader builds reach the graphics card a few at a time. The card here is a stand-in that writes down every call it
// gets, and a build is done when the test says.

import { describe, expect, it } from "vitest";
import { ShaderQueue, buildsAtOnce, holdingBuilds } from "../src/ui/viewport/render/shaderQueue";

const COMPLETION_STATUS_KHR = 0x91b1;
const LINK_STATUS = 0x8b82;

interface P {
  name: string;
  linked: boolean;
  done: boolean;
}
interface S {
  name: string;
  compiled: boolean;
  gone: boolean;
}

function card(limit: number) {
  const calls: string[] = [];
  let clock = 0;
  const timers: { at: number; work: () => void }[] = [];
  const gl = {
    createProgram: (name: string): P => ({ name, linked: false, done: false }),
    createShader: (name: string): S => ({ name, compiled: false, gone: false }),
    compileShader(s: S) {
      if (s.gone) throw new Error(`${s.name} compiled after it was let go of`);
      s.compiled = true;
      calls.push(`compile ${s.name}`);
    },
    attachShader(p: P, s: S) {
      calls.push(`attach ${s.name} to ${p.name}`);
    },
    linkProgram(p: P) {
      p.linked = true;
      calls.push(`link ${p.name}`);
    },
    deleteShader(s: S) {
      s.gone = true;
      calls.push(`drop ${s.name}`);
    },
    deleteProgram(p: P) {
      calls.push(`delete ${p.name}`);
    },
    getProgramParameter(p: P, what: number) {
      if (what === COMPLETION_STATUS_KHR) return p.linked ? p.done : true;
      calls.push(`ask ${p.name}`);
      if (!p.linked) throw new Error(`${p.name} asked about before it was linked`);
      return true;
    },
    getProgramInfoLog(p: P) {
      if (!p.linked) throw new Error(`${p.name} asked about before it was linked`);
      return "";
    },
    useProgram(p: P | null) {
      if (p && !p.linked) throw new Error(`${p.name} used before it was linked`);
    },
    getShaderInfoLog(s: S) {
      if (!s.compiled) throw new Error(`${s.name} asked about before it was compiled`);
      return "";
    },
  };
  const q = new ShaderQueue(
    gl as unknown as WebGLRenderingContext,
    limit,
    () => clock,
    (work, ms) => {
      const t = { at: clock + ms, work };
      timers.push(t);
      return t as unknown as ReturnType<typeof setTimeout>;
    },
  );
  /** as the renderer makes a program: two shaders compiled, attached, the program linked */
  const make = (name: string): P => {
    const p = gl.createProgram(name);
    for (const kind of ["v", "f"]) {
      const s = gl.createShader(`${name}.${kind}`);
      gl.compileShader(s);
      gl.attachShader(p, s);
      (p as unknown as { shaders: S[] }).shaders = [...((p as unknown as { shaders?: S[] }).shaders ?? []), s];
    }
    gl.linkProgram(p);
    return p;
  };
  const shadersOf = (p: P) => (p as unknown as { shaders: S[] }).shaders;
  const linked = () => calls.filter((c) => c.startsWith("link ")).map((c) => c.slice(5));
  /** time passes: every look that falls due is taken, in order */
  const pass = (ms: number) => {
    const until = clock + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > until) break;
      timers.shift();
      clock = t.at;
      t.work();
    }
    clock = until;
  };
  return { gl, q, calls, make, shadersOf, linked, pass, timers };
}

describe("the queue of shader builds", () => {
  it("gives the card a quarter as many builds at once as the PC has threads, and at least one", () => {
    expect(buildsAtOnce(8)).toBe(2);
    expect(buildsAtOnce(16)).toBe(4);
    expect(buildsAtOnce(4)).toBe(1);
    expect(buildsAtOnce(2)).toBe(1);
    expect(buildsAtOnce(64)).toBe(6);
    expect(buildsAtOnce(0)).toBe(1);
  });

  it("holds nothing back that is not handed over ahead of a draw", () => {
    const c = card(1);
    c.make("a");
    c.make("b");
    expect(c.linked()).toEqual(["a", "b"]);
    expect(c.calls.slice(0, 5)).toEqual(["compile a.v", "attach a.v to a", "compile a.f", "attach a.f to a", "link a"]);
    expect(c.q.size).toBe(0);
  });

  it("gives the card as many as it takes at once, and the next as each is done, in the order asked", () => {
    const c = card(2);
    const [p1, p2, p3, p4] = holdingBuilds(() => ["a", "b", "c", "d"].map(c.make));
    expect(c.linked()).toEqual(["a", "b"]);
    expect(c.q.size).toBe(2);
    expect(c.q.waiting(p3)).toBe(true);
    expect(c.q.waiting(p1)).toBe(false);
    // a held build says "not done", like one the card is at work on
    expect(c.gl.getProgramParameter(p3, COMPLETION_STATUS_KHR)).toBe(false);
    expect(c.gl.getProgramParameter(p1, COMPLETION_STATUS_KHR)).toBe(false);
    // nothing of a held build has reached the card but that its shaders are attached
    expect(c.calls.filter((x) => x.includes("c."))).toEqual(["attach c.v to c", "attach c.f to c"]);
    p2.done = true;
    c.pass(100);
    expect(c.linked()).toEqual(["a", "b", "c"]);
    // its shaders were compiled first
    const at = c.calls.indexOf("link c");
    expect(c.calls.slice(at - 2, at)).toEqual(["compile c.v", "compile c.f"]);
    p1.done = true;
    p3.done = true;
    c.pass(100);
    expect(c.linked()).toEqual(["a", "b", "c", "d"]);
    expect(c.q.size).toBe(0);
    p4.done = true;
    expect(c.gl.getProgramParameter(p4, COMPLETION_STATUS_KHR)).toBe(true);
    expect(c.q.heldBack).toBe(2);
    expect(c.q.most).toBe(2);
  });

  it("moves on as soon as the renderer hears that a build is done", () => {
    const c = card(1);
    const [p1] = holdingBuilds(() => ["a", "b"].map(c.make));
    expect(c.linked()).toEqual(["a"]);
    p1.done = true;
    // (asked by the renderer, no look of the queue's own in between)
    expect(c.gl.getProgramParameter(p1, COMPLETION_STATUS_KHR)).toBe(true);
    expect(c.linked()).toEqual(["a", "b"]);
  });

  it("looks again soon after the card had room, and less and less often while it has none", () => {
    const c = card(1);
    holdingBuilds(() => ["a", "b"].map(c.make));
    const due: number[] = [];
    let now = 0;
    for (let i = 0; i < 8; i++) {
      const next = c.timers[0].at;
      due.push(next - now);
      c.pass(next - now);
      now = next;
    }
    expect(due.slice(0, 6)).toEqual([2, 4, 8, 16, 32, 48]);
    expect(due[7]).toBe(48);
  });

  it("builds at once a held build that is drawn with or asked about, and waits for it there", () => {
    const c = card(1);
    const [, p2, p3, p4] = holdingBuilds(() => ["a", "b", "c", "d"].map(c.make));
    expect(c.linked()).toEqual(["a"]);
    c.gl.useProgram(p3);
    expect(c.linked()).toEqual(["a", "c"]);
    c.gl.getProgramParameter(p2, LINK_STATUS);
    expect(c.linked()).toEqual(["a", "c", "b"]);
    // a shader of a held build asked about: the whole build goes
    c.gl.getShaderInfoLog(c.shadersOf(p4)[1]);
    expect(c.linked()).toEqual(["a", "c", "b", "d"]);
    c.gl.useProgram(null);
  });

  it("lets go of a held build's shaders only after they were compiled and linked", () => {
    const c = card(1);
    const [p1, p2] = holdingBuilds(() => ["a", "b"].map(c.make));
    for (const s of c.shadersOf(p2)) c.gl.deleteShader(s);
    expect(c.calls.filter((x) => x.startsWith("drop"))).toEqual([]);
    p1.done = true;
    c.pass(10);
    expect(c.calls.slice(-5)).toEqual(["compile b.v", "compile b.f", "link b", "drop b.v", "drop b.f"]);
    // one not held is let go of at once
    for (const s of c.shadersOf(p1)) c.gl.deleteShader(s);
    expect(c.calls.slice(-2)).toEqual(["drop a.v", "drop a.f"]);
  });

  it("never builds a held build that is thrown away, and moves on when one with the card is", () => {
    const c = card(1);
    const [p1, p2, p3] = holdingBuilds(() => ["a", "b", "c"].map(c.make));
    c.gl.deleteShader(c.shadersOf(p2)[0]);
    c.gl.deleteProgram(p2);
    expect(c.calls.slice(-2)).toEqual(["drop b.v", "delete b"]);
    expect(c.linked()).toEqual(["a"]);
    c.gl.deleteProgram(p1);
    expect(c.linked()).toEqual(["a", "c"]);
    expect(c.q.waiting(p3)).toBe(false);
    expect(c.calls.some((x) => x.startsWith("compile b"))).toBe(false);
    // its other shader, let go of later, goes straight to the card
    c.gl.deleteShader(c.shadersOf(p2)[1]);
    expect(c.calls.at(-1)).toBe("drop b.f");
  });

  it("gives the card the builds a picture waits for first, and the others one at a time after them", () => {
    const c = card(2);
    const spare = holdingBuilds(() => ["s1", "s2", "s3"].map(c.make), false);
    // one build nothing waits for at a time, though the card takes two
    expect(c.linked()).toEqual(["s1"]);
    const urgent = holdingBuilds(() => ["u1", "u2", "u3"].map(c.make), true);
    expect(c.linked()).toEqual(["s1", "u1"]);
    urgent[0].done = true;
    c.pass(100);
    expect(c.linked()).toEqual(["s1", "u1", "u2"]);
    spare[0].done = true;
    c.pass(100);
    expect(c.linked()).toEqual(["s1", "u1", "u2", "u3"]);
    urgent[1].done = urgent[2].done = true;
    c.pass(100);
    expect(c.linked()).toEqual(["s1", "u1", "u2", "u3", "s2"]);
    c.pass(1000);
    expect(c.linked().length).toBe(5);
    spare[1].done = true;
    c.pass(100);
    expect(c.linked()).toEqual(["s1", "u1", "u2", "u3", "s2", "s3"]);
  });

  it("moves a build up when a picture comes to wait for it", () => {
    const c = card(1);
    const [u1] = holdingBuilds(() => [c.make("u1")], true);
    const [, s2] = holdingBuilds(() => ["s1", "s2"].map(c.make), false);
    holdingBuilds(() => [c.make("u2")], true);
    c.q.urge(s2);
    u1.done = true;
    c.pass(100);
    expect(c.linked()).toEqual(["u1", "s2"]);
    expect(c.q.sentAt(s2)).toBeGreaterThan(0);
  });

  it("does not let a build the card says nothing about keep the others back for ever", () => {
    const c = card(1);
    holdingBuilds(() => ["a", "b"].map(c.make));
    c.pass(29_000);
    expect(c.linked()).toEqual(["a"]);
    c.pass(2000);
    expect(c.linked()).toEqual(["a", "b"]);
  });

  it("holds nothing back when told to give the card everything at once", () => {
    const c = card(Infinity);
    holdingBuilds(() => ["a", "b", "c"].map(c.make));
    expect(c.linked()).toEqual(["a", "b", "c"]);
    expect(c.calls.slice(0, 5)).toEqual(["compile a.v", "attach a.v to a", "compile a.f", "attach a.f to a", "link a"]);
  });

  it("forgets everything when the card was reset", () => {
    const c = card(1);
    const [, p2] = holdingBuilds(() => ["a", "b"].map(c.make));
    c.q.reset();
    expect(c.q.size).toBe(0);
    expect(c.q.waiting(p2)).toBe(false);
    c.pass(1000);
    expect(c.linked()).toEqual(["a"]);
    // and takes builds again
    holdingBuilds(() => ["c", "d"].map(c.make));
    expect(c.linked()).toEqual(["a", "c"]);
  });
});
