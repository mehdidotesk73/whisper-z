// A random display name for a participant with no account — shown to other
// participants instead of a raw public key. Purely cosmetic: the real
// identity is the public key, this is just what humans see.
const ADJECTIVES = [
  'Blue', 'Red', 'Green', 'Golden', 'Silver', 'Quiet', 'Swift', 'Bright',
  'Calm', 'Bold', 'Gentle', 'Clever', 'Lucky', 'Misty', 'Sunny', 'Wild',
]

const NOUNS = [
  'Fox', 'Bear', 'Wolf', 'Hawk', 'Otter', 'Falcon', 'Rabbit', 'Heron',
  'Lynx', 'Sparrow', 'Badger', 'Raven', 'Deer', 'Owl', 'Fern', 'Pine',
]

export function randomGuestName(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  return `${adjective}${noun}`
}
