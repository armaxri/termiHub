/**
 * Deliver `connection-ids-changed` backend events in component tests (#3603).
 *
 * Wraps the global mocked Tauri `listen` (see `src/test/setup.ts`): subscriptions
 * to `connection-ids-changed` are captured, every other event falls through to
 * whatever implementation the test (or another harness) installed before.
 */

import { act } from "react";
import { vi } from "vitest";
import { listen, type EventCallback } from "@tauri-apps/api/event";
import { CONNECTION_IDS_CHANGED_EVENT } from "@/services/events";
import type { ConnectionIdChange } from "@/types/connection";

export interface ConnectionIdChangesHarness {
  /** Deliver one batch to every live subscriber, inside `act`. */
  emit: (changes: ConnectionIdChange[]) => void;
  /** Number of live subscriptions (unsubscribed ones are dropped). */
  listenerCount: () => number;
}

export function installConnectionIdChangesHarness(): ConnectionIdChangesHarness {
  const handlers = new Set<EventCallback<ConnectionIdChange[]>>();
  const mocked = vi.mocked(listen);
  const previous = mocked.getMockImplementation();
  mocked.mockImplementation(((
    event: string,
    handler: EventCallback<unknown>,
    options?: unknown
  ) => {
    if (event === CONNECTION_IDS_CHANGED_EVENT) {
      const h = handler as EventCallback<ConnectionIdChange[]>;
      handlers.add(h);
      return Promise.resolve(() => {
        handlers.delete(h);
      });
    }
    return previous
      ? (previous as (...args: unknown[]) => Promise<() => void>)(event, handler, options)
      : Promise.resolve(() => {});
  }) as typeof listen);
  return {
    emit: (changes) => {
      act(() => {
        for (const h of [...handlers]) {
          h({ event: CONNECTION_IDS_CHANGED_EVENT, id: 0, payload: changes });
        }
      });
    },
    listenerCount: () => handlers.size,
  };
}
