# SPDX-License-Identifier: GPL-2.0-or-later

set(CMAKE_AUTOMOC ON)
find_package(Qt6 REQUIRED COMPONENTS CorePrivate)
set(QT_NATIVE_TESTS "${PROJECT_SOURCE_DIR}/externals/qtbase/tests/manual/wasm")
set(QT_NATIVE_TESTLIB "${QT_NATIVE_TESTS}/qtwasmtestlib")
set(QT_NATIVE_TIMERS "${QT_NATIVE_TESTS}/eventloop/suspendresumecontrol_auto")

qt_add_executable(suspendresumecontrol_auto MANUAL_FINALIZATION
    "${QT_NATIVE_TIMERS}/main.cpp"
    "${QT_NATIVE_TESTLIB}/qtwasmtestlib.cpp")
target_include_directories(suspendresumecontrol_auto PRIVATE "${QT_NATIVE_TESTLIB}")
target_link_libraries(suspendresumecontrol_auto PRIVATE Qt6::Core Qt6::CorePrivate)
set_target_properties(suspendresumecontrol_auto PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")
qt_finalize_executable(suspendresumecontrol_auto)
add_custom_command(TARGET suspendresumecontrol_auto POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -E copy
        "${QT_NATIVE_TIMERS}/suspendresumecontrol_auto.html"
        "$<TARGET_FILE_DIR:suspendresumecontrol_auto>/suspendresumecontrol_auto.html"
    COMMAND "${CMAKE_COMMAND}" -E copy "${QT_NATIVE_TESTLIB}/qtwasmtestlib.js"
        "$<TARGET_FILE_DIR:suspendresumecontrol_auto>/qtwasmtestlib.js"
    VERBATIM)

qt_add_executable(dialog_exec "${QT_NATIVE_TESTS}/eventloop/dialog_exec/main.cpp")
target_link_libraries(dialog_exec PRIVATE Qt6::Widgets)
set_target_properties(dialog_exec PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")

qt_add_executable(foreignwindows "${QT_NATIVE_TESTS}/foreignwindows/main.cpp")
target_link_libraries(foreignwindows PRIVATE Qt6::Widgets)
set_target_properties(foreignwindows PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")

qt_add_executable(localfiles "${QT_NATIVE_TESTS}/localfiles/main.cpp")
target_link_libraries(localfiles PRIVATE Qt6::Widgets)
set_target_properties(localfiles PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")

add_custom_target(azahar_qt_native_fixtures
    DEPENDS suspendresumecontrol_auto dialog_exec foreignwindows localfiles)
