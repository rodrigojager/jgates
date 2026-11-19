rule make:
  output: 'out.txt'
  log: 'logs/make.log'
  container: 'docker://alpine:3.20'
  shell: 'echo hi > {output} 2> {log}'
