"""Shared typing surface for the focused UI-helper mixins (issue #831).

Every ``*Ui`` mixin in this package is combined with
:class:`~termihub_harness.SystemTest`, which sits last in the MRO and supplies
the real ``driver`` (a class var set by the suite fixture) and ``wait``
(poll-until-truthy). :class:`HarnessMixin` declares just those two so a mixin's
own methods type-check against them without redeclaring the signatures in every
file.

``driver`` is a bare annotation (no assignment) and ``wait`` lives under
``TYPE_CHECKING``, so neither creates a runtime attribute — they never shadow the
real ``SystemTest`` members during method resolution.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Callable, TypeVar

from ..bridge import Driver

_T = TypeVar("_T")


class HarnessMixin:
    """Borrowed ``SystemTest`` surface (``driver`` + ``wait``) for UI mixins."""

    driver: Driver
    if TYPE_CHECKING:

        def wait(
            self,
            predicate: Callable[[], _T],
            *,
            timeout: float = ...,
            interval: float = ...,
            what: str = ...,
        ) -> _T: ...

    def is_disabled(self, test_id: str) -> bool:
        """Whether a control is disabled.

        React reflects a truthy ``disabled`` prop to the attribute (present → an
        empty string, absent → ``None``), so a non-``None`` value means disabled.
        """
        return self.driver.get_attribute(test_id, "disabled") is not None
