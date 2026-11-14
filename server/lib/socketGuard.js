/**
 * One guard around every Socket.IO event handler.
 *
 * Socket.IO runs a handler with nothing around it: a handler that throws, or an
 * async one that rejects, is an uncaught exception, and Node ends the process.
 * So one signed-in client could stop the server for everyone by sending
 * `typing` with no payload, or `join-group` with something that is not an id
 * (the audit, BUILD_NOTES Entry 148). A check inside each handler is only as
 * good as the handler somebody forgets, so the guard is where handlers are
 * registered instead.
 *
 * What the guard does:
 * - a payload is an object, or a string for the events that take a bare id;
 *   anything else becomes `{}` or `''`, so a handler can always destructure it;
 * - whatever the handler throws or rejects with is caught, logged by message,
 *   and answered with the socket's `error` event.
 */

/** The payload a handler is given: an object as it came, anything else as `{}`. */
function objectPayload(data) {
  return data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

/** A bare id, for the events that take one: a string as it came, anything else as `''`. */
function idPayload(data) {
  return typeof data === 'string' ? data : '';
}

/**
 * `on(event, handler, { id })` for one socket. `id: true` for an event whose
 * payload is a bare id; otherwise the payload is an object.
 */
function guardedOn(socket, log = console.error) {
  return (event, handler, { id = false } = {}) => {
    socket.on(event, async (data) => {
      try {
        await handler(id ? idPayload(data) : objectPayload(data));
      } catch (err) {
        log(`Error in socket event ${event}:`, err && err.message);
        socket.emit('error', { message: 'That did not work' });
      }
    });
  };
}

module.exports = { guardedOn, objectPayload, idPayload };
