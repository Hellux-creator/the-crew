// Notifications. The public key is meant to be in the app; the private one lives only in the sender.
export const VAPID_PUBLIC = "BJ-76n_qQ5p8CzCK4ISHGM0RCT_SRYQqdYMzkQPxmPCpJYN5wqgv2CeeFhEgre9ynnx3r1QL1O4khOlAZP2JheQ";
// Address of the notification sender (Cloudflare Worker). Empty = not switched on yet:
// people can already turn notifications on, they just won't be sent until this is filled in.
export const NOTIFY_URL = "https://the-crew-push.crew-push.workers.dev";
