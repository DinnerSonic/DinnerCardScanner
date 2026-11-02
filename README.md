# Card Tally Scanner

Phone camera scanner for Pokémon TCG cards. Hold a card inside the outline and it's recognized by its
artwork, then pick the exact print (non-holo, reverse, pattern…) and add it to a batch you paste into Card Tally.

- Matches against ~23,500 English and Japanese cards using small artwork fingerprints (`fp.bin`), all on the phone.
- Fingerprints are built by `tools/artfp.py`; `match.js` computes the same fingerprint from the camera.
- Card data and images from [TCGdex](https://github.com/tcgdex/cards-database) (MIT); card images are loaded from TCGdex's image server.
- The batch is kept in this browser only until you copy it out.
