import { describe, expect, it } from "vitest";
import { cardName } from "../src/app/desktop";

describe("graphics card name", () => {
  it("reads the card from ANGLE's renderer strings", () => {
    expect(cardName("ANGLE (AMD, AMD Radeon RX 7800 XT (0x0000747E) Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("AMD Radeon RX 7800 XT");
    expect(cardName("ANGLE (AMD, Vulkan 1.3.260 (AMD Radeon RX 7800 XT (0x0000747E)), AMD proprietary driver)")).toBe("AMD Radeon RX 7800 XT");
    expect(cardName("ANGLE (AMD, AMD Radeon RX 7800 XT OpenGL 4.6.0 Core Profile Context 24.8.1, OpenGL 4.6)")).toBe("AMD Radeon RX 7800 XT");
    expect(cardName("ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe("NVIDIA GeForce RTX 4070");
    expect(cardName("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)")).toBe("SwiftShader Device (Subzero)");
  });
  it("leaves other strings alone", () => {
    expect(cardName("Apple M2")).toBe("Apple M2");
  });
});
