import time


def replace_checkpoint(source, destination):
    for attempt in range(40):
        try:
            source.replace(destination)
            return
        except PermissionError:
            if attempt == 39:
                raise
            time.sleep(0.05)
