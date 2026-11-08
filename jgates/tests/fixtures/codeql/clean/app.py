import subprocess
from flask import Flask

app = Flask(__name__)


@app.route("/ping")
def ping():
    subprocess.run(["ping", "-c", "1", "localhost"], check=False)
    return "ok"
