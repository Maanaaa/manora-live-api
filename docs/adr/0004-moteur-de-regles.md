# ADR 0004 — Moteur de règles

- Statut : accepté
- Date : 2026-11-12

## Contexte

Les automatismes (« si présence devant la borne alors compte à rebours », « si la télécommande passe en veille alors éteindre la lumière de la borne ») doivent être modifiables depuis le back-office sans redéployer. Le format des règles est fixé par l'ADR 0002. Le sujet demande des tests du moteur.

## Décision

- Les règles sont stockées en base et rechargées dans le moteur à chaque création, modification ou suppression.
- Le moteur (`src/rules/engine.ts`) est un **module pur** : il reçoit les mesures (`handleReading`) et un battement d'horloge (`tick`, chaque seconde) et renvoie les règles à déclencher. L'horloge est injectée, ce qui rend les tests déterministes. L'exécution des actions est faite par `Fleet`.
- **Front montant** : une règle se déclenche quand sa condition *devient* vraie, une seule fois tant qu'elle reste vraie ; elle se réarme quand la condition redevient fausse.
- **`forSeconds`** : la condition doit rester vraie N secondes ; si elle retombe avant, rien ne se passe.
- **`schedule`** : fenêtre `after`–`before` en heure de Paris (`Europe/Paris`), bornes optionnelles, fenêtre de nuit si `after > before`. Évaluée au moment du déclenchement : un front hors fenêtre est ignoré.
- **Comparaisons** : `eq`/`neq` selon le type de la valeur attendue (binaire souple : `true`, `"ON"`, `1` sont équivalents ; textes sans casse) ; `gt`/`lt` seulement sur des nombres.
- **Actions** : `notify` → Expo Push (`https://exp.host/--/api/v2/push/send`) vers les jetons des comptes `admin` et `host`, plus une entrée `rule` au journal ; `command` → `terminal.command` au terminal (sans attendre le retour) ; `booth` → `booth.countdown|sleep|wake` aux bornes connectées.
- Les événements rejoués par la file du Pi et datés de plus de 2 minutes sont enregistrés mais ne déclenchent pas de règle (éviter un compte à rebours pour une présence passée). Un appareil désactivé ne déclenche pas de règle.

## Conséquences

- Le comportement est couvert par `tests/engine.test.ts` sans base ni réseau.
- L'état des fronts est en mémoire : après un redémarrage, la première mesure vraie compte comme un front.
