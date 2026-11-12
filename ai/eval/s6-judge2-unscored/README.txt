UNSCORED: kept for the record, never compared with labels (BUILD_NOTES Entry 129).

qwen/qwen3.8-27b on set 2, run 1 (62 items, 47 with a verdict, 15 refused by Groq's per-minute limit after three passes)
and run 2 (one verdict, c01), stopped 2026-11-12 at about 19:50 UTC. Made with judge-v2 as committed in 4f099ba, which
still said a claim is "partly" when "the sources say something narrower or weaker".

Set aside by the human before any verdict was compared with any label, for two fixes made before any comparison:
that phrase was dropped from judge-v2 so it matches the labelling guidelines, and the Groq provider now paces each
call to its own count of the minute's tokens, besides the headers. All four runs were then made fresh. The harness
does not read this folder.
