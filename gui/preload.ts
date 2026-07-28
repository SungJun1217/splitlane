import { contextBridge, ipcRenderer } from "electron";
import { MIRROR_CHANNEL, type MirrorState } from "./bridge.ts";

/** Exposes exactly one capability: observing state. There is no method here that
 * sends anything, so the window has no way to reach the session that publishes
 * to it. */
contextBridge.exposeInMainWorld("splitlaneMirror", {
  subscribe(listener: (state: MirrorState) => void): () => void {
    const handler = (_event: unknown, state: MirrorState) => listener(state);
    ipcRenderer.on(MIRROR_CHANNEL, handler);
    return () => ipcRenderer.off(MIRROR_CHANNEL, handler);
  },
});
