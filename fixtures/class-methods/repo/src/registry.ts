export const registry = {
  register() {
    return true;
  },

  lookup: function (key: string) {
    return key;
  },

  count: () => 0,
};
