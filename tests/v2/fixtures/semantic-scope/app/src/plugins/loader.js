// Plugins are loaded by name at run time: which module is imported is not known statically.
export async function loadPlugin(name) {
  return import(`./${name}.js`);
}
