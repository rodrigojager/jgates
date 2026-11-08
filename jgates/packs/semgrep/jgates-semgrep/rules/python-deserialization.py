import json
import marshal
import pickle
import yaml


def load(blob, text):
    # ruleid: jgates.python.unsafe-deserialization
    pickle.loads(blob)
    # ruleid: jgates.python.unsafe-deserialization
    marshal.loads(blob)
    # ok: jgates.python.unsafe-deserialization
    json.loads(text)


def load_yaml(text):
    # ruleid: jgates.python.unsafe-yaml-load
    yaml.load(text)
    # ruleid: jgates.python.unsafe-yaml-load
    yaml.load(text, Loader=yaml.Loader)
    # ok: jgates.python.unsafe-yaml-load
    yaml.safe_load(text)
    # ok: jgates.python.unsafe-yaml-load
    yaml.load(text, Loader=yaml.SafeLoader)
