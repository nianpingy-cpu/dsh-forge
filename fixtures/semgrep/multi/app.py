import subprocess


def shell(cmd):
    return subprocess.run(cmd, shell=True)
