type Listener = (...args: never[]) => void;

export class EventBus<Events extends { [K in keyof Events]: Listener }> {
  private readonly listeners = new Map<keyof Events, Set<Listener>>();

  on<K extends keyof Events>(event: K, listener: Events[K]): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => this.off(event, listener);
  }

  off<K extends keyof Events>(event: K, listener: Events[K]): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as (...values: Parameters<Events[K]>) => void)(...args);
      } catch (error) {
        // A throwing dApp listener must not break the transport that emitted.
        setTimeout(() => {
          throw error;
        }, 0);
      }
    }
  }
}
