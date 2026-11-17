// The one lifecycle every missiv store has: it works (polls, holds a socket)
// only while someone is subscribed, and only for the current account. A run
// starts on the first subscription for the source's current key, is stopped and
// replaced when the key changes (another account, a sign-out), and is stopped
// with the last unsubscription. Whatever a run started, it stops in its cleanup;
// a run that was stopped can no longer write the store.
import { get as getValue, writable, type Readable } from 'svelte/store';

export type RunContext<T> = {
	set(value: T): void;
	update(fn: (value: T) => T): void;
	get(): T;
	/** false once this run is stopped: an async step that resumes after it must do nothing */
	readonly active: boolean;
};

export type ActiveStore<T> = Readable<T> & {
	/** the current value, also when nobody is subscribed */
	get(): T;
};

export function activeStore<S, T>(params: {
	source: Readable<S>;
	/** what a run is for: a change of key replaces the run */
	key(source: S): string;
	initial: T;
	/** start the work for this source value; return what stops it */
	run(source: S, ctx: RunContext<T>): (() => void) | void;
}): ActiveStore<T> {
	const store = writable<T>(params.initial, () => {
		let currentKey: string | undefined;
		let stopRun: (() => void) | undefined;
		const unsubscribe = params.source.subscribe((value) => {
			const key = params.key(value);
			if (key === currentKey) {
				return;
			}
			currentKey = key;
			stopRun?.();
			stopRun = start(value);
		});
		return () => {
			unsubscribe();
			stopRun?.();
			stopRun = undefined;
		};
	});

	function start(value: S) {
		let active = true;
		const ctx: RunContext<T> = {
			set(v) {
				if (active) store.set(v);
			},
			update(fn) {
				if (active) store.update(fn);
			},
			get: () => getValue(store),
			get active() {
				return active;
			}
		};
		const cleanup = params.run(value, ctx);
		return () => {
			active = false;
			cleanup?.();
		};
	}

	return { subscribe: store.subscribe, get: () => getValue(store) };
}

/**
 * Call `task` now and again `intervalMs` after each call settles, until the run
 * stops (or the returned function is called). A failing call is reported to
 * `onError` and polling goes on.
 */
export function poll(
	ctx: { readonly active: boolean },
	intervalMs: number,
	task: () => Promise<void>,
	onError: (err: unknown) => void
): () => void {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	async function tick() {
		timeout = undefined;
		try {
			await task();
		} catch (err) {
			if (ctx.active && !stopped) onError(err);
		}
		if (ctx.active && !stopped) {
			timeout = setTimeout(tick, intervalMs);
		}
	}
	tick();
	return () => {
		stopped = true;
		if (timeout) clearTimeout(timeout);
	};
}

/** An error as a store shows it. */
export type StoreError = { message: string; code?: string; cause?: unknown };

export function toStoreError(message: string, cause: unknown): StoreError {
	const code =
		cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
			? cause.code
			: undefined;
	const detail = cause instanceof Error ? cause.message : undefined;
	return { message: detail ? `${message}: ${detail}` : message, code, cause };
}
