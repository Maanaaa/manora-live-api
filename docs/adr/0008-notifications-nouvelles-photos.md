# ADR 0008 — Notifications « nouvelles photos dans la galerie »

- Statut : accepté
- Date : 2026-11-13

## Contexte

Théo veut que les invités soient prévenus quand une photo est ajoutée à la galerie en direct. Pendant une soirée, la borne peut produire une photo toutes les minutes : une notification par photo serait du spam.

## Décision

- À chaque photo ajoutée (borne ou invité), `PhotoNotifier` (`src/photo-notifier.ts`) prévient les téléphones des **invités du même événement**, sauf l'auteur de la photo.
- **Regroupement par téléphone** : la première photo est notifiée tout de suite, puis au plus une notification par fenêtre de 5 minutes, qui annonce le nombre de photos ajoutées (« 4 nouvelles photos dans la galerie « … » »).
- La notification porte `data.url = "/gallery"` : l'app ouvre la galerie au toucher.
- Les jetons qu'Expo signale « DeviceNotRegistered » (app désinstallée) sont supprimés, pour les photos comme pour les règles.
- Envoi en tâche de fond : l'envoi d'une photo ne dépend jamais de la réussite de la notification.

## Conséquences

- Testé avec une horloge simulée (`tests/photo-notifier.test.ts`).
- Les compteurs en attente sont en mémoire : un redémarrage de l'API pendant une fenêtre perd au plus un envoi groupé.
- Les notifications des règles (action `notify`) restent destinées aux comptes admin et hôte.
