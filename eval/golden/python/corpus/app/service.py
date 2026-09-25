from app.store import Store, open_store


def save(key, value):
    store = open_store()
    store.put(key, value)
    return store


def load(key):
    return Store().get(key)
