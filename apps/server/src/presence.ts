/**
 * Characters currently in a world room, so the same character can't be logged in
 * twice. In-process only: when the server runs as several processes this moves
 * to Colyseus presence (Redis).
 */
export const onlineCharacters = new Set<number>();

