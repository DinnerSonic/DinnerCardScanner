# Card Tally Scanner

Phone camera scanner for Pokémon TCG cards. Reads the code line in a card's bottom-left corner
(e.g. `SVI EN 086/198`), looks it up, and collects cards into a batch you paste into Card Tally.

- Works on English Scarlet & Violet era and newer cards (the ones that print a set code).
- Text recognition runs on the phone with [Tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0), bundled in `vendor/`.
- Card list from [TCGdex](https://github.com/tcgdex/cards-database) (MIT), in `cards-en.json`.
- The batch is kept in this browser only until you copy it out.
