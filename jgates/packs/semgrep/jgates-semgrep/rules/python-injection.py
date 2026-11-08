import os
import subprocess


def sql(cursor, user, name):
    # ruleid: jgates.python.sql-string-building
    cursor.execute(f"SELECT * FROM users WHERE name = '{name}'")
    # ruleid: jgates.python.sql-string-building
    cursor.execute("SELECT * FROM users WHERE name = '%s'" % name)
    # ruleid: jgates.python.sql-string-building
    cursor.execute("SELECT * FROM users WHERE name = '" + name + "'")
    # ruleid: jgates.python.sql-string-building
    cursor.execute("SELECT * FROM users WHERE name = '{}'".format(name))
    # ok: jgates.python.sql-string-building
    cursor.execute("SELECT * FROM users WHERE name = %s", (name,))


def shell(host):
    # ruleid: jgates.python.os-command-injection
    subprocess.run("ping " + host, shell=True)
    # ruleid: jgates.python.os-command-injection
    os.system("ping " + host)
    # ok: jgates.python.os-command-injection
    subprocess.run(["ping", host])
    # ok: jgates.python.os-command-injection
    os.system("uptime")


def dynamic(expression):
    # ruleid: jgates.python.dynamic-code-execution
    eval(expression)
    # ruleid: jgates.python.dynamic-code-execution
    exec(expression)
    # ok: jgates.python.dynamic-code-execution
    eval("1 + 1")
