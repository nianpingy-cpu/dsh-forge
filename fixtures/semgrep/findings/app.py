import subprocess


def run_command(command):
    # security finding: shell=True with a command string
    return subprocess.run(command, shell=True)


def evaluate(expr):
    # security finding: eval on user input
    return eval(expr)
