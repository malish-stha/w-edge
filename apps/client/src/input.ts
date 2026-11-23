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
  private attackQueued = false;
  private abilityQueued = false;
  private ability2Queued = false;
  private ability3Queued = false;
  private ability4Queued = false;
  private interactQueued = false;
  private secondaryQueued = false;
  private teleportQueued = false;
  private lastShiftTapAt = 0;
  private mouseDown = false;
  private secondaryDown = false;
  private listeners = new Map<string, Array<() => void>>();
  /** Timestamp (ms) of the last manual mouse look, so soft lock-on yields to player aim. */
  lastLookAt = 0;

  /** Treat input as captured even without pointer lock (automated tests). */
  forceActive = false;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      // Typing in a form field (character name, etc.) isn't game input.
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === "Space") this.jumpQueued = true;
      if (e.code === "KeyQ") this.dodgeQueued = true;
      if (e.code === "Digit1") this.abilityQueued = true;
      if (e.code === "Digit2") this.ability2Queued = true;
      if (e.code === "Digit3") this.ability3Queued = true;
      if (e.code === "Digit4") this.ability4Queued = true;
      if (e.code === "KeyE") this.interactQueued = true;
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
        const now = performance.now();
        if (now - this.lastShiftTapAt <= 380) {
          this.teleportQueued = true;
          this.lastShiftTapAt = 0;
        } else {
          this.lastShiftTapAt = now;
        }
      }
      // Test mode has no mouse capture: F attacks, R triggers secondary mechanic.
      if (e.code === "KeyF" && this.forceActive) this.attackQueued = true;
      if (e.code === "KeyR" && this.forceActive) this.secondaryQueued = true;
      this.keys.add(e.code);
      this.emit(e.code);
      // Keep the page from scrolling or the browser from acting on game keys.
      if (this.locked && ["Space", "ControlLeft", "KeyW", "KeyS", "KeyA", "KeyD", "KeyQ", "KeyC", "KeyE", "KeyF", "KeyR", "KeyK", "KeyG", "KeyV", "Tab", "Digit1", "Digit2", "Digit3", "Digit4", "ShiftLeft", "ShiftRight"].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener("keyup", (e) => { this.keys.delete(e.code); this.emit(`${e.code}:up`); });
    window.addEventListener("blur", () => { this.keys.clear(); this.mouseDown = false; this.secondaryDown = false; });

    canvas.addEventListener("click", () => this.lock());
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    // Left button attacks (holding it keeps the combo going); right button runs class mechanic / guard; middle pings.
    canvas.addEventListener("mousedown", (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      if (e.button === 0) { this.attackQueued = true; this.mouseDown = true; }
      else if (e.button === 1) { e.preventDefault(); this.emit("MiddleMouse"); }
      else if (e.button === 2) { this.secondaryQueued = true; this.secondaryDown = true; }
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouseDown = false;
      else if (e.button === 1) this.emit("MiddleMouse:up");
      else if (e.button === 2) this.secondaryDown = false;
    });
    document.addEventListener("mousemove", (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      const sensitivity = 0.0022;
      this.yaw += e.movementX * sensitivity;
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - e.movementY * sensitivity));
      if (Math.abs(e.movementX) + Math.abs(e.movementY) > 1) this.lastLookAt = performance.now();
    });
    canvas.addEventListener("wheel", (e) => {
      this.zoom = Math.max(3, Math.min(24, this.zoom * (e.deltaY > 0 ? 1.1 : 0.9)));
      e.preventDefault();
    }, { passive: false });
  }

  get locked() {
    return this.forceActive || document.pointerLockElement === this.canvas;
  }

  lock() {
    if (document.pointerLockElement !== this.canvas) {
      const request = this.canvas.requestPointerLock() as unknown;
      if (request instanceof Promise) request.catch(() => { });
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
    if (!this.locked) {
      // Menu open: stand still (the world keeps running).
      this.clearPresses();
      return { moveX: 0, moveZ: 0, yaw: Math.fround(this.wrappedYaw()), pitch: Math.fround(this.pitch), buttons: 0 };
    }
    let buttons = 0;
    if (this.held("Space")) buttons |= Buttons.JumpHeld;
    if (this.jumpQueued) buttons |= Buttons.JumpPressed;
    if (this.held("ControlLeft", "ControlRight", "KeyC")) buttons |= Buttons.Descend;
    if (this.held("ShiftLeft", "ShiftRight")) buttons |= Buttons.Boost;
    if (this.dodgeQueued) buttons |= Buttons.DodgePressed;
    if (this.attackQueued || this.mouseDown) buttons |= Buttons.AttackPressed;
    if (this.abilityQueued) buttons |= Buttons.Ability1Pressed;
    if (this.ability2Queued) buttons |= Buttons.Ability2Pressed;
    if (this.ability3Queued) buttons |= Buttons.Ability3Pressed;
    if (this.ability4Queued) buttons |= Buttons.Ability4Pressed;
    if (this.interactQueued) buttons |= Buttons.InteractPressed;
    if (this.held("KeyE")) buttons |= Buttons.InteractHeld;
    if (this.secondaryQueued) buttons |= Buttons.SecondaryPressed;
    if (this.secondaryDown || (this.forceActive && this.held("KeyR"))) buttons |= Buttons.SecondaryHeld;
    if (this.teleportQueued) buttons |= Buttons.TeleportPressed;
    this.clearPresses();
    const moveZ = (this.held("KeyW", "ArrowUp") ? 100 : 0) - (this.held("KeyS", "ArrowDown") ? 100 : 0);
    const moveX = (this.held("KeyD", "ArrowRight") ? 100 : 0) - (this.held("KeyA", "ArrowLeft") ? 100 : 0);
    // Quantise the angles to float32 so prediction uses exactly what the server receives.
    return { moveX, moveZ, yaw: Math.fround(this.wrappedYaw()), pitch: Math.fround(this.pitch), buttons };
  }

  private clearPresses() {
    this.jumpQueued = false;
    this.dodgeQueued = false;
    this.attackQueued = false;
    this.abilityQueued = false;
    this.ability2Queued = false;
    this.ability3Queued = false;
    this.ability4Queued = false;
    this.interactQueued = false;
    this.secondaryQueued = false;
    this.teleportQueued = false;
  }

  private wrappedYaw() {
    const twoPi = Math.PI * 2;
    return this.yaw - Math.floor((this.yaw + Math.PI) / twoPi) * twoPi;
  }
}
