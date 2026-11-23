import { Mode, RIM_Z, STAMINA_MAX } from "@worlds-edge/shared";
import type { PlayerView } from "./session.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const MODE_LABELS: Record<number, string> = {
  [Mode.Ground]: "Walking",
  [Mode.Air]: "Airborne",
  [Mode.Flight]: "Flying",
  [Mode.Dive]: "Diving",
};

export class Hud {
  private root = $("hud");
  private status = $("status");
  private mode = $("mode");
  private speed = $("speed");
  private altitude = $("altitude");
  private staminaFill = $("stamina-fill");
  private compass = $("compass");
  private help = $("help");
  private debug = $("debug");
  private labelLayer = $("labels");
  private labels = new Map<string, HTMLDivElement>();

  show() { this.root.hidden = false; }
  toggleHelp() { this.help.hidden = !this.help.hidden; }
  toggleDebug() { this.debug.hidden = !this.debug.hidden; }
  get debugVisible() { return !this.debug.hidden; }

  setStatus(text: string) {
    if (this.status.textContent !== text) this.status.textContent = text;
  }

  setDebug(text: string) { this.debug.textContent = text; }

  update(self: PlayerView) {
    const hSpeed = Math.hypot(self.vx, self.vz);
    const speed = Math.hypot(self.vx, self.vy, self.vz);
    let label = MODE_LABELS[self.mode] ?? "";
    if (self.mode === Mode.Flight && hSpeed < 2 && Math.abs(self.vy) < 2) label = "Hovering";
    if (self.mode === Mode.Flight && hSpeed > 20) label = "Boosting";
    this.mode.textContent = label;
    this.speed.textContent = `${Math.round(speed)} m/s`;
    this.altitude.textContent = `${Math.round(self.y)} m`;
    this.staminaFill.style.width = `${(self.stamina / STAMINA_MAX) * 100}%`;
    this.staminaFill.classList.toggle("exhausted", self.exhausted === 1);

    const toRim = self.z - RIM_Z;
    this.compass.innerHTML = toRim > 0
      ? `World's Edge <b>${toRim >= 1000 ? (toRim / 1000).toFixed(1) + " km" : Math.round(toRim) + " m"}</b> — fly toward the bright horizon`
      : `<b>Beyond the rim</b> — the settlement lies below the falls`;
  }

  /** Name tags above other players. `project` returns screen coordinates or null if off-screen. */
  updateLabels(players: PlayerView[], project: (x: number, y: number, z: number) => { x: number; y: number } | null) {
    const seen = new Set<string>();
    for (const p of players) {
      if (p.isSelf) continue;
      seen.add(p.id);
      let el = this.labels.get(p.id);
      if (!el) {
        el = document.createElement("div");
        el.className = "label";
        this.labelLayer.appendChild(el);
        this.labels.set(p.id, el);
      }
      if (el.textContent !== p.name) el.textContent = p.name;
      el.style.borderBottom = `2px solid ${p.color}`;
      const s = project(p.x, p.y + 2.5, p.z);
      if (s) {
        el.style.display = "";
        el.style.left = `${s.x}px`;
        el.style.top = `${s.y}px`;
      } else {
        el.style.display = "none";
      }
    }
    for (const [id, el] of this.labels) {
      if (!seen.has(id)) { el.remove(); this.labels.delete(id); }
    }
  }
}
