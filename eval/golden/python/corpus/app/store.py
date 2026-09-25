class Store:
    def __init__(self):
        self.items = {}

    def get(self, key):
        return self.items.get(key)

    def put(self, key, value):
        self._check(key)
        self.items[key] = value

    def _check(self, key):
        if not key:
            raise ValueError(key)


def open_store():
    return Store()
