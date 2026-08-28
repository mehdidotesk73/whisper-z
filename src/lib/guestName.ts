// A random display name for a participant with no account — shown to other
// participants instead of a raw public key. Purely cosmetic: the real
// identity is the public key, this is just what humans see.
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

export function randomGuestName(): string {
  const color = COLORS[Math.floor(Math.random() * COLORS.length)]
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  return `${color}${noun}`
}
