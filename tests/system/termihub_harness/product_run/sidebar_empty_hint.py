"""Grade that the empty Connections sidebar names no experimental feature (#5954).

#5873 turned the empty Connections sidebar's experimental signpost into one
short sentence and one button. The next UI review (#5954) found the note in the
wrong place: "Workflows are still experimental. Turn on in Settings." at the
end of the Connections empty state read as if connections needed an
experimental switch. It moved to the Workflows view and left with it: the
Automations view (#5818) needs no switch.

:func:`connections_empty_problems` grades the Connections empty state's text.
"""

from __future__ import annotations

from typing import Optional

#: The Connections empty-state card.
CONNECTIONS_EMPTY = "connections-empty-state"

#: Words that must not show in the Connections empty state.
FORBIDDEN_IN_CONNECTIONS = ("experimental", "workflow", "automation", "turn on")


def connections_empty_problems(text: Optional[str]) -> list[str]:
    """What is wrong with the Connections empty state's text (#5954).

    ``text`` is the card's visible text, ``None`` when there is no card. The
    card is about connections only: it names no experimental feature and offers
    no "turn on" action.
    """
    if text is None:
        return ["no empty-state card on the Connections sidebar"]
    lower = text.lower()
    return [
        f"the Connections empty state mentions {word!r}: {text!r}"
        for word in FORBIDDEN_IN_CONNECTIONS
        if word in lower
    ]
