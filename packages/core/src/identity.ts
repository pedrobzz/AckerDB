/** Durable, provider-neutral application identity assigned by ackerdb. */
export type Identity = bigint & { readonly __ackerdbIdentity: unique symbol };
