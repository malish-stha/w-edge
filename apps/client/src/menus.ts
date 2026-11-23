import {
  CLASSES, HAIR_COLORS, MANTLES, NAME_MAX, ORIGINS, OUTFIT_COLORS, SKIN_TONES,
  randomDraft, validateDraft,
  type CharacterDraft, type CharacterSummary,
} from "@worlds-edge/shared";

type Child = Node | string | null | undefined | false;

/** Tiny DOM helper: h("button", { class: "x", onclick }, "Label"). */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "style") el.setAttribute("style", String(v));
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const label = (list: readonly { id: string; name: string }[], id: string) => list.find((x) => x.id === id)?.name ?? id;

export function describe(c: { origin: string; classId: string; mantle: string }) {
  return `${label(ORIGINS, c.origin)} ${label(CLASSES, c.classId)} · ${label(MANTLES, c.mantle)}`;
}

export class Menus {
  private root = document.getElementById("screen") as HTMLDivElement;

  hide() {
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  private show(card: HTMLElement, side = false) {
    this.root.hidden = false;
    this.root.classList.toggle("side", side);
    this.root.replaceChildren(card);
    card.querySelector<HTMLElement>("[autofocus]")?.focus();
  }

  private card(...children: Child[]) {
    return h("div", { class: "card" }, h("h1", {}, "World's Edge"), ...children);
  }

  loading(text: string) {
    this.show(this.card(h("p", { class: "muted" }, text)));
  }

  message(text: string, actions: { label: string; primary?: boolean; run: () => void }[]) {
    this.show(this.card(
      h("p", {}, text),
      h("div", { class: "actions" }, ...actions.map((a) => h("button", { class: a.primary ? "primary" : "secondary", onclick: a.run }, a.label))),
    ));
  }

  signIn(opts: {
    googleSlot: boolean;
    devLogin: boolean;
    onDev: (player: string) => Promise<void>;
    onSolo: () => void;
    error?: string;
  }): HTMLElement | null {
    const note = h("p", { class: "note error", role: "alert" }, opts.error ?? "");
    const googleSlot = opts.googleSlot ? h("div", { class: "google-slot" }) : null;
    let dev: HTMLElement | null = null;
    if (opts.devLogin) {
      const input = h("input", { id: "dev-account", placeholder: "tester1", maxLength: 24, autocomplete: "off", spellcheck: false, autofocus: !opts.googleSlot });
      const go = async () => {
        note.textContent = "";
        button.disabled = true;
        try { await opts.onDev(input.value.trim() || "tester"); }
        catch (err) { note.textContent = (err as Error).message; button.disabled = false; }
      };
      const button = h("button", { class: "secondary", onclick: go }, "Continue with test account");
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      dev = h("div", { class: "dev-login" },
        h("label", { for: "dev-account" }, "Test account (development only)"),
        h("div", { class: "row" }, input, button),
      );
    }
    this.show(this.card(
      h("p", { class: "tagline" }, "Fly from First Harbour across the ocean to the edge of the world."),
      googleSlot,
      !opts.googleSlot && !opts.devLogin ? h("p", { class: "muted" }, "Sign-in isn't set up on this server yet.") : null,
      dev,
      note,
      h("button", { class: "link", onclick: opts.onSolo }, "Fly solo without signing in"),
    ));
    return googleSlot;
  }

  characters(opts: {
    list: CharacterSummary[];
    max: number;
    onPlay: (c: CharacterSummary) => Promise<void>;
    onDelete: (c: CharacterSummary) => Promise<void>;
    onCreate: () => void;
    onSignOut: () => void;
    error?: string;
  }) {
    const note = h("p", { class: "note error", role: "alert" }, opts.error ?? "");
    const rows = opts.list.map((c) => {
      let confirming = false;
      const del = h("button", {
        class: "icon-button", title: `Delete ${c.name}`, "aria-label": `Delete ${c.name}`,
        onclick: async () => {
          if (!confirming) { confirming = true; del.textContent = "Delete?"; del.classList.add("danger"); return; }
          del.disabled = true;
          try { await opts.onDelete(c); } catch (err) { note.textContent = (err as Error).message; del.disabled = false; }
        },
      }, "✕");
      const play = h("button", {
        class: "primary",
        onclick: async () => {
          play.disabled = true;
          try { await opts.onPlay(c); } catch (err) { note.textContent = (err as Error).message; play.disabled = false; }
        },
      }, "Play");
      return h("li", { class: "character" },
        h("span", { class: "swatch", style: `background:${c.appearance.outfit};border-color:${c.appearance.hair}` }),
        h("span", { class: "who" }, h("strong", {}, c.name), h("small", {}, `Level ${c.level} ${describe(c)}`)),
        play, del,
      );
    });
    this.show(this.card(
      h("h2", {}, "Your characters"),
      h("ul", { class: "characters" }, ...rows),
      opts.list.length < opts.max
        ? h("button", { class: "secondary", onclick: opts.onCreate }, "Create character")
        : h("p", { class: "muted" }, `You have the maximum of ${opts.max} characters.`),
      note,
      h("button", { class: "link", onclick: opts.onSignOut }, "Sign out"),
    ));
  }

  /** Character creation. `onChange` fires on every edit so the 3D preview can follow. */
  create(opts: {
    canGoBack: boolean;
    onChange: (d: CharacterDraft) => void;
    onSubmit: (d: CharacterDraft) => Promise<void>;
    onBack: () => void;
  }) {
    let draft: CharacterDraft = { name: "", ...randomDraft() };
    const note = h("p", { class: "note error", role: "alert" });
    const nameInput = h("input", {
      id: "char-name", maxLength: NAME_MAX, autocomplete: "off", spellcheck: false, placeholder: "Name your character", autofocus: true,
      oninput: () => { draft.name = nameInput.value; },
    });

    const choice = (title: string, list: readonly { id: string; name: string; blurb: string }[], key: "origin" | "classId" | "mantle") => {
      const group = h("div", { class: "choices", role: "radiogroup", "aria-label": title });
      const blurb = h("p", { class: "blurb" });
      const render = () => {
        group.replaceChildren(...list.map((o) => h("button", {
          type: "button", role: "radio", class: "choice", "aria-checked": String(draft[key] === o.id),
          onclick: () => { (draft as unknown as Record<string, string>)[key] = o.id; refresh(); },
        }, o.name)));
        blurb.textContent = list.find((o) => o.id === draft[key])?.blurb ?? "";
      };
      renderers.push(render);
      return h("fieldset", {}, h("legend", {}, title), group, blurb);
    };

    const swatches = (title: string, colors: readonly string[], key: "skin" | "hair" | "outfit") => {
      const group = h("div", { class: "swatches", role: "radiogroup", "aria-label": title });
      renderers.push(() => group.replaceChildren(...colors.map((c, i) => h("button", {
        type: "button", role: "radio", class: "swatch-button", style: `background:${c}`,
        "aria-checked": String(draft.appearance[key] === c), "aria-label": `${title} ${i + 1}`,
        onclick: () => { draft.appearance[key] = c; refresh(); },
      }))));
      return h("fieldset", {}, h("legend", {}, title), group);
    };

    const renderers: (() => void)[] = [];
    const refresh = () => { for (const r of renderers) r(); opts.onChange(draft); };

    const submit = h("button", {
      class: "primary",
      onclick: async () => {
        draft.name = nameInput.value;
        const problem = validateDraft(draft);
        if (problem) { note.textContent = problem; return; }
        note.textContent = "";
        submit.disabled = true;
        try { await opts.onSubmit(draft); } catch (err) { note.textContent = (err as Error).message; submit.disabled = false; }
      },
    }, "Create and play");

    const card = h("div", { class: "card create" },
      h("h2", {}, "Create character"),
      h("label", { for: "char-name" }, "Name"),
      nameInput,
      choice("Origin", ORIGINS, "origin"),
      choice("Class", CLASSES, "classId"),
      choice("Starter mantle", MANTLES, "mantle"),
      h("div", { class: "appearance" },
        swatches("Skin", SKIN_TONES, "skin"),
        swatches("Hair", HAIR_COLORS, "hair"),
        swatches("Outfit", OUTFIT_COLORS, "outfit"),
      ),
      h("p", { class: "muted small" }, "Your mantle awakens at the training-yard shrine. You can change class and mantle there later."),
      note,
      h("div", { class: "actions" },
        h("button", { class: "secondary", type: "button", onclick: () => { draft = { name: nameInput.value, ...randomDraft() }; refresh(); } }, "Randomise"),
        submit,
      ),
      opts.canGoBack ? h("button", { class: "link", onclick: opts.onBack }, "Back to characters") : null,
    );
    this.show(card, true);
    refresh();
  }
}
