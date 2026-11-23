import { Buttons, type MoveInput } from "@worlds-edge/shared";

const PITCH_LIMIT = 1.45;

/**
 * Keyboard and mouse. Presses are latched until the next simulation step
 * consumes them, so a quick tap between two steps is never lost.
 */
export class Input {
  /** Start facing outward (negative z): toward the World's Edge. */
  yaw = Math.PI;
  pitch = -0.2;
  zoom = 8;
  private keys = new Set<string>();
  private jumpQueued = false;
  private dodgeQueued = false;
  private listeners = new Map<string, Array<() => void>>();

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      if (e.code === "Space") this.jumpQueued = true;
      if (e.code === "KeyQ") this.dodgeQueued = true;
      this.keys.add(e.code);
      this.emit(e.code);
      // Keep the page from scrolling or the browser from acting on game keys.
      if (this.locked && ["Space", "ControlLeft", "KeyW", "KeyS", "KeyA", "KeyD", "KeyQ", "KeyC", "ShiftLeft"].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());

    canvas.addEventListener("click", () => this.lock());
    document.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      const sensitivity = 0.0022;
      this.yaw += e.movementX * sensitivity;
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - e.movementY * sensitivity));
    });
    canvas.addEventListener("wheel", (e) => {
      this.zoom = Math.max(3, Math.min(24, this.zoom * (e.deltaY > 0 ? 1.1 : 0.9)));
      e.preventDefault();
    }, { passive: false });
  }

  get locked() {
    return document.pointerLockElement === this.canvas;
  }

  lock() {
    if (!this.locked) {
      const request = this.canvas.requestPointerLock() as unknown;
      if (request instanceof Promise) request.catch(() => {});
    }
  }

  on(code: string, fn: () => void) {
    const list = this.listeners.get(code) ?? [];
    list.push(fn);
    this.listeners.set(code, list);
  }

  private emit(code: string) {
    for (const fn of this.listeners.get(code) ?? []) fn();
  }

  private held(...codes: string[]) {
    return codes.some((c) => this.keys.has(c));
  }

  /** Build the input for one fixed step and consume latched presses. */
  sample(): MoveInput {
    let buttons = 0;
    if (this.held("Space")) buttons |= Buttons.JumpHeld;
    if (this.jumpQueued) buttons |= Buttons.JumpPressed;
    if (this.held("ControlLeft", "ControlRight", "KeyC")) buttons |= Buttons.Descend;
    if (this.held("ShiftLeft", "ShiftRight")) buttons |= Buttons.Boost;
    if (this.dodgeQueued) buttons |= Buttons.DodgePressed;
    this.jumpQueued = false;
    this.dodgeQueued = false;
    const moveZ = (this.held("KeyW", "ArrowUp") ? 100 : 0) - (this.held("KeyS", "ArrowDown") ? 100 : 0);
    const moveX = (this.held("KeyD", "ArrowRight") ? 100 : 0) - (this.held("KeyA", "ArrowLeft") ? 100 : 0);
    // Quantise the angles to float32 so prediction uses exactly what the server receives.
    return { moveX, moveZ, yaw: Math.fround(this.wrappedYaw()), pitch: Math.fround(this.pitch), buttons };
  }

  private wrappedYaw() {
    const twoPi = Math.PI * 2;
    return this.yaw - Math.floor((this.yaw + Math.PI) / twoPi) * twoPi;
  }
}
