'use strict';

// Rink-board "sponsors". All fictional, for fun. Set ADS_ENABLED=false to hide them everywhere.
const SPONSORS = [
  { key: 'robert-sucks', name: 'Robert Sucks', alt: 'Robert Sucks: official sponsor of missed open nets', featured: true },
  { key: 'five-hole-pizza', name: 'Five Hole Pizza', alt: 'Five Hole Pizza: always finds a way through' },
  { key: 'sin-bin-tavern', name: 'Sin Bin Tavern', alt: 'Sin Bin Tavern: serving two minutes at a time' },
  { key: 'top-shelf-taproom', name: 'Top Shelf Taproom', alt: 'Top Shelf Taproom: where mama keeps the good stuff' },
  { key: 'fresh-sheet-ice', name: 'Fresh Sheet Ice Care', alt: 'Fresh Sheet Ice Care: resurfacing since the second intermission' },
  { key: 'barn-burner-bbq', name: 'Barn Burner BBQ', alt: 'Barn Burner BBQ: smoked low and slow, like our defense' },
  { key: 'biscuit-bakery', name: 'Biscuit in the Basket Bakery', alt: 'Biscuit in the Basket Bakery: fresh pucks daily' },
];

const enabled = !['0', 'false', 'no', 'off'].includes(String(process.env.ADS_ENABLED || 'true').toLowerCase());

// Picks a sponsor for a single slot; the featured sponsor shows up about half the time.
function pick() {
  if (Math.random() < 0.5) return SPONSORS.find((s) => s.featured);
  const others = SPONSORS.filter((s) => !s.featured);
  return others[Math.floor(Math.random() * others.length)];
}

module.exports = { SPONSORS, enabled, pick };
