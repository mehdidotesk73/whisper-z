// A guest's display name — shown to other participants instead of a raw
// public key. Deterministic: derived purely from the public key itself, so
// every viewer computes the exact same name for the same key with no
// lookup and no storage — the "no account found for this sender" fallback
// used by SessionView.vue's nameFor(). Purely cosmetic either way: the real
// identity is always the public key.
const COLORS = [
  'Red', 'Ruby', 'Copper', 'Pink', 'Magenta', 'Amber', 'Orange', 'Yellow',
  'Gold', 'Green', 'Emerald', 'Lime', 'Sage', 'Blue', 'Cobalt', 'Cyan',
  'Teal', 'Purple', 'Indigo', 'Charcoal', 'Brown', 'Beige', 'White',
  'Black', 'Gray', 'Silver', 'Maroon', 'Turquoise', 'Azure', 'Bronze',
]

const NOUNS = [
  'Lion', 'Tiger', 'Bear', 'Wolf', 'Fox', 'Elephant', 'Giraffe', 'Zebra',
  'Monkey', 'Gorilla', 'Chimpanzee', 'Kangaroo', 'Koala', 'Panda', 'Cheetah',
  'Leopard', 'Jaguar', 'Panther', 'Hyena', 'Jackal', 'Deer', 'Moose', 'Elk',
  'Reindeer', 'Bison', 'Buffalo', 'Rhinoceros', 'Hippopotamus', 'Camel',
  'Llama', 'Alpaca', 'Horse', 'Donkey', 'Rabbit', 'Hare', 'Squirrel',
  'Chipmunk', 'Beaver', 'Otter', 'Raccoon', 'Opossum', 'Hedgehog',
  'Porcupine', 'Bat', 'Mole', 'Shrew', 'Mouse', 'Rat', 'Hamster',
  'GuineaPig', 'Ferret', 'Weasel', 'Badger', 'Skunk', 'Walrus', 'Seal',
  'SeaLion', 'Whale', 'Dolphin', 'Shark', 'Octopus', 'Squid', 'Jellyfish',
  'Starfish', 'Eagle', 'Hawk', 'Falcon', 'Owl', 'Crow', 'Raven', 'Bluejay',
  'Cardinal', 'Robin', 'Sparrow', 'Pigeon', 'Dove', 'Seagull', 'Pelican',
  'Flamingo', 'Swan', 'Duck', 'Goose', 'Turkey', 'Chicken', 'Rooster',
  'Peacock', 'Parrot', 'Macaw', 'Toucan', 'Penguin', 'Ostrich', 'Emu',
  'Alligator', 'Crocodile', 'Turtle', 'Tortoise', 'Snake', 'Python',
  'Cobra', 'Viper', 'Lizard', 'Iguana', 'Chameleon', 'Gecko', 'Frog',
  'Toad', 'Salamander', 'Rose', 'Tulip', 'Daisy', 'Sunflower', 'Orchid',
  'Lily', 'Marigold', 'Peony', 'Daffodil', 'Carnation', 'Lotus', 'Jasmine',
  'Lavender', 'Hibiscus', 'Iris', 'Poppy', 'Violet', 'Petunia', 'Magnolia',
  'Chrysanthemum', 'Bluebell', 'Hyacinth', 'Camellia', 'Azalea', 'Begonia',
  'Dandelion', 'Clover', 'Buttercup', 'Anemone', 'Primrose', 'Snapdragon',
  'Zinnia', 'Aster', 'Freesia', 'Lilac', 'Hydrangea', 'Gardenia',
  'Poinsettia', 'Thistle', 'Geranium', 'Pansy', 'MorningGlory',
]

/** A small, fast, non-cryptographic string hash (djb2) — plenty for picking a cosmetic name. */
function hashString(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i)
  }
  return h >>> 0
}

/**
 * Color+noun alone (31 × 149 ≈ 4.6k combinations) collides too often once
 * there are many guest identities around, so a 3-character base36 suffix
 * (36³ ≈ 46.7k) is appended — still derived purely from the key, so it's
 * exactly as deterministic and storage-free as the rest of the name.
 */
export function guestNameForKey(publicKeyId: string): string {
  const hash = hashString(publicKeyId)
  const color = COLORS[hash % COLORS.length]
  const noun = NOUNS[Math.floor(hash / COLORS.length) % NOUNS.length]
  const suffix = (hash % 46656).toString(36).toUpperCase().padStart(3, '0')
  return `${color}${noun}${suffix}`
}

const MAX_DISPLAYED_NAME_LENGTH = 20

/** Usernames are arbitrary-length; truncate wherever one is shown inline next to a message or list row. */
export function truncateName(name: string): string {
  return name.length > MAX_DISPLAYED_NAME_LENGTH ? `${name.slice(0, MAX_DISPLAYED_NAME_LENGTH)}…` : name
}
