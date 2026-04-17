from __future__ import annotations

import asyncio
import logging
import signal

import click

from .config import Config
from .controller import UsherController


@click.command(context_settings={"help_option_names": ["-h", "--help"]})
@click.option("--config", "-c", default="config.yaml", show_default=True)
@click.option("--verbose", "-v", is_flag=True, help="Debug logging")
@click.option("--list-channels", "-l", is_flag=True,
              help="Print channel list from director and exit")
def main(config: str, verbose: bool, list_channels: bool) -> None:
    """usher -- IR remote control for the movie stack."""
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    cfg = Config.load(config)

    if list_channels:
        asyncio.run(_print_channels(cfg))
        return

    controller = UsherController(cfg)

    async def _run() -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(
                sig, lambda: loop.create_task(controller.shutdown())
            )
        await controller.run()

    asyncio.run(_run())


async def _print_channels(cfg: Config) -> None:
    from .director import DirectorClient

    client   = DirectorClient(cfg.director.url, timeout=cfg.director.timeout)
    channels = await client.get_channels()
    await client.close()

    if not channels:
        print("No channels returned by director.")
        return

    print(f"{'CH':>4}  {'Name':<30}  Stream URL")
    print("─" * 72)
    for ch in channels:
        print(f"{ch.number:>4}  {ch.name:<30}  {ch.stream_url}")


if __name__ == "__main__":
    main()
