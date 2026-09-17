#!/usr/bin/env python3
"""Test-only StatusNotifier watcher/host on the isolated native test session bus."""
import os
import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

items = []
host = True
fail_properties = False
connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
xml = """<node><interface name="org.kde.StatusNotifierWatcher">
<method name="RegisterStatusNotifierItem"><arg type="s" direction="in"/></method>
<method name="RegisterStatusNotifierHost"><arg type="s" direction="in"/></method>
<property name="RegisteredStatusNotifierItems" type="as" access="read"/>
<property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
<property name="ProtocolVersion" type="i" access="read"/>
<signal name="StatusNotifierItemRegistered"><arg type="s"/></signal>
<signal name="StatusNotifierItemUnregistered"><arg type="s"/></signal>
<signal name="StatusNotifierHostRegistered"/>
</interface><interface name="io.runlab.TrayTest">
<method name="SetHost"><arg type="b" direction="in"/></method>
<method name="ClearItems"/>
<method name="FailProperties"><arg type="b" direction="in"/></method>
</interface></node>"""


def method(bus, sender, path, interface, name, parameters, invocation):
    global host, fail_properties
    if name == "RegisterStatusNotifierItem":
        item = parameters.unpack()[0]
        if item.startswith("/"):
            item = sender + item
        else:
            item += "/StatusNotifierItem"
        if item not in items:
            items.append(item)
            connection.emit_signal(None, path, "org.kde.StatusNotifierWatcher",
                                   "StatusNotifierItemRegistered", GLib.Variant("(s)", (item,)))
    elif name == "SetHost":
        host = parameters.unpack()[0]
    elif name == "ClearItems":
        items.clear()
    elif name == "FailProperties":
        fail_properties = parameters.unpack()[0]
    invocation.return_value(None)


def prop(bus, sender, path, interface, name):
    if fail_properties:
        return None
    return {
        "RegisteredStatusNotifierItems": GLib.Variant("as", items),
        "IsStatusNotifierHostRegistered": GLib.Variant("b", host),
        "ProtocolVersion": GLib.Variant("i", 0),
    }[name]


for interface in Gio.DBusNodeInfo.new_for_xml(xml).interfaces:
    connection.register_object("/StatusNotifierWatcher", interface, method, prop, None)
Gio.bus_own_name_on_connection(connection, "org.kde.StatusNotifierWatcher",
                             Gio.BusNameOwnerFlags.NONE, None, None)
GLib.MainLoop().run()
