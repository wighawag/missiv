import { writable, type Readable, type Unsubscriber, type Updater } from 'svelte/store';

/** One or more `Readable`s. */
type Stores = Readable<any> | [Readable<any>, ...Array<Readable<any>>] | Array<Readable<any>>;

/** One or more values from `Readable` stores. */
type StoresValues<T> =
	T extends Readable<infer U> ? U : { [K in keyof T]: T[K] extends Readable<infer U> ? U : never };

const noop = () => {};
function run_all(arr: Array<() => void>) {
	for (var i = 0; i < arr.length; i++) {
		arr[i]();
	}
}

/**
 * Derived value store by synchronizing one or more readable stores and
 * applying an aggregation function over its input values.
 */
export function derivedWithStartStopNotifier<S extends Stores, T>(
	stores: S,
	fn: (
		values: StoresValues<S>,
		set: (value: T) => void,
		update: (fn: Updater<T>) => void
	) => Unsubscriber | void,
	initial_value?: T,
	start?: (set: (value: T) => void, update: (fn: Updater<T>) => void) => Unsubscriber | void
): Readable<T>;

/**
 * Derived value store by synchronizing one or more readable stores and
 * applying an aggregation function over its input values.
 */
export function derivedWithStartStopNotifier<S extends Stores, T>(
	stores: S,
	fn: (values: StoresValues<S>) => T,
	initial_value?: T,
	start?: (set: (value: T) => void, update: (fn: Updater<T>) => void) => Unsubscriber | void
): Readable<T>;

/**
 * Implementation of the derived store
 */
export function derivedWithStartStopNotifier<S extends Stores, T>(
	stores: S,
	fn:
		| ((
				values: StoresValues<S>,
				set: (value: T) => void,
				update: (fn: Updater<T>) => void
		  ) => Unsubscriber | void)
		| ((values: StoresValues<S>) => T),
	initial_value?: T,
	start?: (set: (value: T) => void, update: (fn: Updater<T>) => void) => Unsubscriber | void
): Readable<T> {
	const single = !Array.isArray(stores);
	const stores_array: Array<Readable<any>> = single ? [stores] : stores;
	if (!stores_array.every(Boolean)) {
		throw new Error('derived() expects stores as input, got a falsy value');
	}
	const auto = fn.length < 2;

	const store = writable(initial_value, (set, update) => {
		let started = false;
		const values: T[] = [];
		let pending = 0;
		let cleanup: () => void = noop;
		const sync = () => {
			if (pending) {
				return;
			}
			cleanup();
			const result = fn((single ? values[0] : values) as StoresValues<S>, set, update);
			if (auto) {
				set(result as T);
			} else {
				cleanup = typeof result === 'function' ? (result as () => void) : noop;
			}
		};
		const unsubscribers = stores_array.map((store, i) =>
			store.subscribe(
				(value: any) => {
					values[i] = value;
					pending &= ~(1 << i);
					if (started) {
						sync();
					}
				},
				() => {
					pending |= 1 << i;
				}
			)
		);
		started = true;
		let stopFromState: Unsubscriber | void;
		if (start) {
			stopFromState = start(set, update);
		}
		sync();
		return function stop() {
			run_all(unsubscribers);
			cleanup();
			// We need to set this to false because callbacks can still happen despite having unsubscribed:
			// Callbacks might already be placed in the queue which doesn't know it should no longer
			// invoke this derived store.
			started = false;
			if (stopFromState) {
				stopFromState();
			}
		};
	});

	return {
		subscribe: store.subscribe
	};
}
