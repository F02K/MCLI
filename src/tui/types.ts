import type { Core } from '../core';
import type { KeyEvent, MouseEvent } from './input';
import type { Modal } from './modal';

export interface ViewFrame {
  /** Exactly the lines of the view area (the caller pads/truncates them). */
  lines: string[];
  /** Cursor position inside the view (0-based), shown while a text field has focus. */
  cursor?: { x: number; y: number };
}

export interface View {
  readonly id: string;
  readonly title: string;
  render(w: number, h: number): ViewFrame;
  /** Return true if the key was handled (otherwise global shortcuts may use it). */
  onKey(k: KeyEvent): boolean;
  /** Mouse event with coordinates relative to the view (0-based). */
  onMouse?(e: MouseEvent, x: number, y: number): void;
  /** Key hints for the footer. */
  hints(): string;
  onShow?(): void;
  /** Optional badge text for the tab (e.g. a player count). */
  badge?(): string;
}

export type ToastKind = 'info' | 'ok' | 'warn' | 'error';

/** What views can ask of the UI shell. */
export interface UiHost {
  readonly core: Core;
  render(): void;
  modal(m: Modal): void;
  toast(text: string, kind?: ToastKind): void;
  show(viewId: string): void;
  quit(): void;
  /** Asks the user to accept the Minecraft EULA (and optionally starts the server afterwards). */
  eulaPrompt(startAfter?: boolean): void;
  /** Offers to download and install a Java version (and optionally starts the server afterwards). */
  javaPrompt(major: number, startAfter?: boolean): void;
}
