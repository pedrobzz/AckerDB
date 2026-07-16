/** Durable, provider-neutral application identity assigned by dbzz. */
export type Identity = bigint & { readonly __dbzzIdentity: unique symbol };
