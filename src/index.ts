/**
 * dsh-alerts — host half.
 *
 * The plugin is browser-only by design: notifications are posted from the page
 * that already watches the session stores, so no host-side state or transport is
 * involved. This entry exists only so the loader mounts the package, which is
 * what makes `dsh-client-modules` serve `/plugins/dsh-alerts/client.js`.
 */

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-alerts'

/** Host loader entry: nothing to mount on the server side. */
export function apply(): void {}
