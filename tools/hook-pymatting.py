# Source collection gives Numba real source paths for its user cache locator.
# https://pyinstaller.org/en/stable/hooks.html#hook-global-variables
module_collection_mode = 'py'
from PyInstaller.utils.hooks import copy_metadata
datas = copy_metadata('pymatting')
